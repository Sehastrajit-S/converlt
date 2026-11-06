// A Model Builder design trained on a Data-section dataset: which loss it trains with, whether
// the design and the data fit together, fitting a design to a dataset, and the training script
// (epochs over the dataset's DataLoaders, validation each epoch, a checkpoint at the end).
// There is no synthetic-data path: a design trains on real data or not at all.
import type { DataSpec } from "./data.ts";
import { analyzeGraph, className, fileStem, fmtShape, paramNum, TEMPLATES, type GraphAnalysis, type LayerNode, type ModelGraph, type ModelTemplate } from "./modelgraph.ts";

export type TrainMode = "classify" | "binary" | "regress" | "reconstruct" | "diffusion";

export const TRAIN_MODE_LABEL: Record<TrainMode, string> = {
  classify: "classification (cross-entropy)",
  binary: "binary classification (logistic)",
  regress: "regression (mean squared error)",
  reconstruct: "reconstruction (rebuild the input)",
  diffusion: "diffusion (predict the noise)",
};

const same = (a: number[] | null | undefined, b: number[] | null | undefined) => !!a && !!b && fmtShape(a) === fmtShape(b);
const prod = (s: number[]) => s.reduce((a, b) => a * b, 1);

function ends(g: ModelGraph, a: GraphAnalysis) {
  const input = g.nodes.find((n) => n.type === "Input");
  const output = g.nodes.find((n) => n.type === "Output");
  return { input, output, inShape: input ? a.nodes[input.id]?.shape ?? null : null, outShape: output ? a.nodes[output.id]?.shape ?? null : null };
}

/** How a design trains on a dataset, from the Output's loss setting, the shapes and the labels. */
export function trainMode(g: ModelGraph, a: GraphAnalysis, spec: DataSpec): TrainMode {
  if (g.nodes.some((n) => n.type === "Timestep")) return "diffusion";
  const { output, inShape, outShape } = ends(g, a);
  const choice = String(output?.params.loss ?? "auto");
  if (choice === "reconstruct" || (choice === "auto" && spec.inputDtype === "float" && same(inShape, outShape))) return "reconstruct";
  if (choice === "regress" || (choice === "auto" && spec.task === "regression")) return "regress";
  if (choice === "binary" || (choice === "auto" && outShape?.length === 1 && outShape[0] === 1 && spec.task === "classification")) return "binary";
  return "classify";
}

/** Why this design can't train on this dataset as it stands. Empty when it can. */
export function designDataIssues(g: ModelGraph, a: GraphAnalysis, spec: DataSpec, datasetName: string): string[] {
  const issues = [...spec.blockers];
  if (!spec.inputShape) return issues;
  const { input, inShape, outShape } = ends(g, a);
  if (!input || !inShape || !outShape) return issues;
  const isLong = input.params.dtype === "token ids";
  if (!same(inShape, spec.inputShape) || isLong !== (spec.inputDtype === "long"))
    issues.push(`${datasetName} gives ${spec.inputDtype === "long" ? "token ids " : ""}${fmtShape(spec.inputShape)}, but the Input is ${isLong ? "token ids " : ""}${fmtShape(inShape)}. Fit to data sets it.`);
  if (spec.vocab) {
    const small = g.nodes.find((n) => n.type === "Embedding" && paramNum(n.params.num_embeddings, 0) < spec.vocab!);
    if (small) issues.push(`Token ids go up to ${spec.vocab - 1}, but the Embedding's vocabulary is ${paramNum(small.params.num_embeddings, 0)}.`);
  }
  const mode = trainMode(g, a, spec);
  const label = spec.targetShape.length ? `${fmtShape(spec.targetShape)} labels` : "one label per example";
  switch (mode) {
    case "diffusion":
    case "reconstruct":
      if (spec.inputDtype !== "float") issues.push(`A ${mode === "diffusion" ? "diffusion model" : "model that rebuilds its input"} needs float data, not token ids.`);
      else if (!same(outShape, inShape)) issues.push(`It ${mode === "diffusion" ? "predicts the noise" : "rebuilds its input"}, so the output must be ${fmtShape(inShape)}; it's ${fmtShape(outShape)}.`);
      break;
    case "classify":
      if (spec.task !== "classification") issues.push(spec.task === "none" ? `${datasetName} has no labels: only models that rebuild their input (autoencoders) or diffusion models train on it.` : `${datasetName} has numeric targets: set the Output's loss to regress.`);
      else if (spec.classes && outShape.at(-1) !== spec.classes) issues.push(`${datasetName} has ${spec.classes} classes, but the output gives ${outShape.at(-1)} scores. Fit to data sets the last layer.`);
      else if (!same(outShape.slice(0, -1), spec.targetShape)) issues.push(`${datasetName} has ${label}, but the output is ${fmtShape(outShape)}.`);
      break;
    case "binary":
      if (spec.task !== "classification" || (spec.classes ?? 2) > 2) issues.push(`A single output score is for two classes; ${datasetName} ${spec.task === "classification" ? `has ${spec.classes}` : "isn't classification"}.`);
      break;
    case "regress":
      if (spec.task === "none") issues.push(`${datasetName} has no targets to regress on.`);
      else if (prod(outShape) !== Math.max(1, prod(spec.targetShape))) issues.push(`${datasetName} has ${label}, but the output is ${fmtShape(outShape)}.`);
      break;
  }
  return issues;
}

const PASS_THROUGH = new Set(["ReLU", "GELU", "SiLU", "LeakyReLU", "Tanh", "Sigmoid", "Softmax", "Dropout"]);

/** The layer that sets the output size: walks back from the Output past activations and dropout. */
function headOf(g: ModelGraph): LayerNode | undefined {
  const into = (id: string) => g.edges.filter((e) => e.to === id).map((e) => g.nodes.find((n) => n.id === e.from)!);
  let n = g.nodes.find((x) => x.type === "Output");
  for (let i = 0; n && i < 20; i++) {
    const prev: LayerNode[] = into(n.id);
    if (prev.length !== 1) return undefined;
    n = prev[0];
    if (n && !PASS_THROUGH.has(n.type)) return n;
  }
  return undefined;
}

/**
 * Sets the design's Input to the dataset's examples and its last layer to what the dataset
 * asks for (class count, target size, or the input's channels for models that rebuild it).
 * Returns the new graph and what changed, in words.
 */
export function fitToData(g: ModelGraph, spec: DataSpec): { graph: ModelGraph; changes: string[] } {
  const graph: ModelGraph = JSON.parse(JSON.stringify(g));
  const changes: string[] = [];
  if (!spec.inputShape) return { graph, changes };
  const before = analyzeGraph(g);
  const modeBefore = trainMode(g, before, spec);
  const input = graph.nodes.find((n) => n.type === "Input");
  const output = graph.nodes.find((n) => n.type === "Output");
  if (!input || !output) return { graph, changes };
  const shape = spec.inputShape.join(",");
  const dtype = spec.inputDtype === "long" ? "token ids" : "float";
  if (input.params.shape !== shape || input.params.dtype !== dtype) {
    input.params = { ...input.params, shape, dtype };
    changes.push(`Input → ${spec.inputShape.join("×")}${dtype === "token ids" ? " token ids" : ""}`);
  }
  if (spec.vocab)
    for (const e of graph.nodes.filter((n) => n.type === "Embedding" && paramNum(n.params.num_embeddings, 0) < spec.vocab!)) {
      e.params = { ...e.params, num_embeddings: spec.vocab };
      changes.push(`Embedding vocabulary → ${spec.vocab}`);
    }
  const head = headOf(graph);
  const key = head?.type === "Linear" ? "out_features" : head && /^Conv/.test(head.type) ? "out_channels" : null;
  let want: number | null = null;
  if (modeBefore === "reconstruct" || modeBefore === "diffusion") want = key === "out_features" ? spec.inputShape.at(-1)! : spec.inputShape[0]!;
  else if (spec.task === "classification" && spec.classes) {
    want = modeBefore === "binary" && spec.classes <= 2 ? 1 : spec.classes;
    if (want !== 1 && output.params.loss === "binary") output.params = { ...output.params, loss: "auto" };
  } else if (spec.task === "regression") {
    want = Math.max(1, prod(spec.targetShape));
    if (output.params.loss !== "regress") {
      output.params = { ...output.params, loss: "regress" };
      changes.push("Output loss → regress");
    }
  }
  if (head && key && want && paramNum(head.params[key], 0) !== want) {
    head.params = { ...head.params, [key]: want };
    changes.push(`Last ${head.type} → ${want} ${key === "out_features" ? "outputs" : "channels"}`);
  }
  return { graph, changes };
}

/**
 * Templates that, fitted to this dataset, are valid and train on it as they are. Ones that learn
 * the dataset's labels (or targets) come first; models that only rebuild or generate the inputs
 * follow. Within each, sorted by model.
 */
export function templatesFitting(spec: DataSpec, datasetName: string): (ModelTemplate & { mode: TrainMode })[] {
  if (!spec.inputShape || spec.blockers.length) return [];
  const out: (ModelTemplate & { mode: TrainMode })[] = [];
  for (const t of TEMPLATES) {
    if (t.id === "blank") continue;
    const g = fitToData(t.make(), spec).graph;
    const a = analyzeGraph(g);
    if (a.ok && designDataIssues(g, a, spec, datasetName).length === 0) out.push({ ...t, mode: trainMode(g, a, spec) });
  }
  const learnsLabels = (m: TrainMode) => (spec.task === "none" ? 0 : m === "reconstruct" || m === "diffusion" ? 1 : 0);
  return out.sort((a, b) => learnsLabels(a.mode) - learnsLabels(b.mode) || (a.model ?? a.label).localeCompare(b.model ?? b.label));
}

export interface TrainData {
  /** The dataset's name, for messages. */
  name: string;
  /** Python module of its loader: data/<stem>_loader.py. */
  loaderStem: string;
  spec: DataSpec;
}

const HEADER = (cls: string, data: TrainData, what: string, stem: string) => [
  `"""Trains ${cls} on ${data.name}: ${what}.`,
  ``,
  `Written by the Converlt Model Builder. Train in the builder rewrites this file; if you edited it,`,
  `your version is kept as train_${stem}.py.bak first. The data comes from data/${data.loaderStem}_loader.py`,
  `(Converlt → Data). Checkpoints go to checkpoints/${stem}.pt.`,
  `    python train_${stem}.py              # epochs sized to the data; or --epochs N --lr X --batch-size B`,
  `"""`,
  `import argparse, math, os, time`,
  `import torch`,
  `from torch import nn`,
  `try:`,
  `    import converge`,
  `except ImportError:  # outside Converlt it still trains, just untracked`,
  `    converge = None`,
];

const COMMON = (cls: string, stem: string, data: TrainData, extraImports: string[], lr: string, extraArgs: string[] = []) => [
  `from models.${stem} import ${cls}, INPUT_SHAPE${extraImports.map((x) => `, ${x}`).join("")}`,
  `from data.${data.loaderStem}_loader import make_loaders`,
  ``,
  `p = argparse.ArgumentParser()`,
  `p.add_argument("--epochs", type=int, default=0, help="0 (default): enough epochs for about 500 steps, at least 10")`,
  `p.add_argument("--batch-size", type=int, default=64)`,
  `p.add_argument("--lr", type=float, default=0, help="0 (default): ${lr === "1e-3" ? "1e-2 for small models (under 50K parameters), 1e-3 otherwise" : lr}")`,
  `p.add_argument("--max-steps", type=int, default=0, help="stop after this many steps (0: run every epoch)")`,
  ...extraArgs,
  `args = p.parse_args()`,
  ``,
  `if torch.cuda.is_available():`,
  `    device = "cuda"`,
  `elif getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():`,
  `    device = "mps"  # Apple silicon GPU`,
  `else:`,
  `    device = "cpu"`,
  ``,
  `# Several GPUs: torchrun starts one copy of this script per GPU (WORLD_SIZE > 1). Each trains on`,
  `# its own share of every epoch (--batch-size is per GPU) and DDP averages the gradients.`,
  `world = int(os.environ.get("WORLD_SIZE", "1"))`,
  `rank = int(os.environ.get("RANK", "0"))`,
  `local_rank = int(os.environ.get("LOCAL_RANK", "0"))`,
  `if world > 1:`,
  `    import torch.distributed as dist`,
  `    dist.init_process_group("nccl" if device == "cuda" else "gloo")`,
  `    if device == "cuda":`,
  `        torch.cuda.set_device(local_rank)`,
  `        device = "cuda:%d" % local_rank`,
  `main = rank == 0  # only the first process logs, evaluates and saves`,
  `device_type = device.split(":")[0]`,
  `amp = torch.bfloat16 if device_type == "cuda" and torch.cuda.is_bf16_supported() else torch.float32`,
  ``,
  `loaders = make_loaders(batch_size=args.batch_size)`,
  `if "train" not in loaders or len(loaders["train"]) == 0:`,
  `    raise SystemExit(${JSON.stringify(`No training data found for ${data.name}.${data.spec.kind === "tabular" ? " Run its preprocessing in Converlt → Data first: training reads the processed splits." : ""}`)})`,
  `train_loader, val_loader = loaders["train"], loaders.get("val")`,
  `if main and converge is not None:  # fingerprints the data, so a reproduction can check it got the same`,
  `    import data.${data.loaderStem}_loader as _data`,
  `    converge.log_dataset(getattr(_data, "DATA_DIR", None) or getattr(_data, "ROOT", None), name=${JSON.stringify(data.name)})`,
  `if world > 1:`,
  `    from torch.utils.data import DataLoader, DistributedSampler`,
  `    train_loader = DataLoader(train_loader.dataset, batch_size=args.batch_size, sampler=DistributedSampler(train_loader.dataset, num_replicas=world, rank=rank, shuffle=True),`,
  `                              num_workers=train_loader.num_workers, pin_memory=train_loader.pin_memory, drop_last=True, persistent_workers=train_loader.num_workers > 0)`,
  `if not args.epochs:`,
  `    # Small datasets give few batches per epoch; size training by optimizer steps instead.`,
  `    args.epochs = min(1000, max(10, math.ceil(500 / len(train_loader))))`,
  `    if main:`,
  `        print("training for %d epochs (%d batches each%s)" % (args.epochs, len(train_loader), ", on %d %s" % (world, "GPUs" if device_type == "cuda" else "processes") if world > 1 else ""))`,
  ``,
  `raw = ${cls}().to(device)  # the model itself; "model" is what trains (wrapped in DDP on several GPUs)`,
  `model = torch.nn.parallel.DistributedDataParallel(raw, device_ids=[local_rank] if device_type == "cuda" else None) if world > 1 else raw`,
  `if not args.lr:`,
  lr === "1e-3"
    ? `    args.lr = 1e-2 if sum(p.numel() for p in raw.parameters()) < 50_000 else 1e-3  # small models learn faster with a larger step`
    : `    args.lr = ${lr}`,
  `opt = torch.optim.AdamW(model.parameters(), lr=args.lr)`,
  `total = args.epochs * len(train_loader)`,
  `if args.max_steps:`,
  `    total = min(total, args.max_steps)`,
  `sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=max(total, 1), pct_start=0.1)`,
  ``,
  ``,
  `def pick_examples(loader, k=5, max_batches=20):`,
  `    """k examples, with different labels where there are labels (loaders are often sorted by class)."""`,
  `    picked, spare, seen = [], [], set()`,
  `    for i, batch in enumerate(loader):`,
  `        for j in range(len(batch[0])):`,
  `            y = batch[1][j] if len(batch) > 1 else None`,
  `            key = int(y) if y is not None and y.numel() == 1 and not y.is_floating_point() else None`,
  `            (spare if key is not None and key in seen else picked).append((batch[0][j], y))`,
  `            seen.add(key)`,
  `            if len(picked) == k:`,
  `                break`,
  `        if len(picked) == k or i + 1 >= max_batches:`,
  `            break`,
  `    picked = (picked + spare)[:k]`,
  `    xs = torch.stack([x for x, _ in picked])`,
  `    return xs, (torch.stack([y for _, y in picked]) if picked[0][1] is not None else None)`,
  ``,
  ``,
  `run = converge.run(config={**vars(args), "model": "${cls}", "dataset": ${JSON.stringify(data.name)}, "gpus": world, "parameters": sum(p.numel() for p in raw.parameters())}, total_steps=total) if converge and main else None`,
  `if run:`,
  `    run.watch(raw)`,
  `    # Five fixed examples, shown in the Model Builder's weights view with the model's predictions over training.`,
  `    shown_x, shown_y = pick_examples(val_loader if val_loader is not None else train_loader)`,
  `    base = getattr(train_loader.dataset, "dataset", train_loader.dataset)`,
  `    run.log_examples(shown_x, shown_y, class_names=getattr(base, "classes", None))`,
  ``,
  ``,
  `def unpack(batch):`,
  `    x = batch[0].to(device, non_blocking=True)`,
  `    y = batch[1].to(device, non_blocking=True) if len(batch) > 1 else None`,
  `    if tuple(x.shape[1:]) != INPUT_SHAPE:`,
  `        raise SystemExit("${data.name} gives inputs of shape %s, but the model expects %s. Use Fit to data in the Model Builder." % (tuple(x.shape[1:]), INPUT_SHAPE))`,
  `    return x, y`,
  ``,
];

const TAIL = (stem: string) => [
  `if main:`,
  `    os.makedirs("checkpoints", exist_ok=True)`,
  `    torch.save(raw.state_dict(), "checkpoints/${stem}.pt")`,
  `    if run:`,
  `        run.log_checkpoint("checkpoints/${stem}.pt", step=step)`,
  `    print("done: %d steps in %.0fs%s, saved checkpoints/${stem}.pt" % (step, time.time() - t0, " on %d %s" % (world, "GPUs" if device_type == "cuda" else "processes") if world > 1 else ""))`,
  `if world > 1:`,
  `    dist.destroy_process_group()`,
  ``,
];

/** The training script for a design on a dataset. Throws if they don't fit together. */
export function generateTrainCode(g: ModelGraph, data: TrainData, a: GraphAnalysis = analyzeGraph(g)): string {
  if (!a.ok) throw new Error(a.errors[0] ?? "Fix the highlighted layers first.");
  const issues = designDataIssues(g, a, data.spec, data.name);
  if (issues.length) throw new Error(issues[0]);
  const stem = fileStem(g.name);
  const cls = className(g.name);
  const mode = trainMode(g, a, data.spec);
  if (mode === "diffusion") return diffusionScript(g, data, stem, cls);
  const classes = ends(g, a).outShape!.at(-1)!;
  const lossLines: Record<Exclude<TrainMode, "diffusion">, string[]> = {
    classify: [
      `def step_loss(out, x, y):`,
      `    out = out.float().reshape(-1, ${classes})`,
      `    y = y.reshape(-1)`,
      `    return nn.functional.cross_entropy(out, y), (out.argmax(-1) == y).sum().item(), y.numel()`,
    ],
    binary: [
      `def step_loss(out, x, y):`,
      `    out, y = out.float().reshape(-1), y.reshape(-1)`,
      `    return nn.functional.binary_cross_entropy_with_logits(out, y.float()), ((out > 0).long() == y.long()).sum().item(), y.numel()`,
    ],
    regress: [
      `def step_loss(out, x, y):`,
      `    y = y.float()`,
      `    return nn.functional.mse_loss(out.float().reshape(y.shape), y), 0, 0`,
    ],
    reconstruct: [
      `def step_loss(out, x, y):  # labels, if any, aren't used: the model rebuilds its input`,
      `    return nn.functional.mse_loss(out.float(), x.float()), 0, 0`,
    ],
  };
  const accuracy = mode === "classify" || mode === "binary";
  return [
    ...HEADER(cls, data, TRAIN_MODE_LABEL[mode], stem),
    ...COMMON(cls, stem, data, [], "1e-3"),
    ...lossLines[mode],
    ``,
    ``,
    `@torch.no_grad()`,
    `def evaluate():`,
    `    raw.eval()  # evaluate the model itself: DDP's collectives would wait for the other GPUs`,
    `    total_loss = n = correct = count = 0`,
    `    for batch in val_loader:`,
    `        x, y = unpack(batch)`,
    `        with torch.autocast(device_type, dtype=amp, enabled=amp != torch.float32):`,
    `            out = raw(x)`,
    `        loss, c, k = step_loss(out, x, y)`,
    `        total_loss += loss.item() * x.size(0)`,
    `        n += x.size(0)`,
    `        correct, count = correct + c, count + k`,
    `    raw.train()`,
    `    metrics = {"val/loss": total_loss / max(n, 1)}`,
    ...(accuracy ? [`    metrics["val/accuracy"] = correct / max(count, 1)`] : []),
    `    return metrics`,
    ``,
    ``,
    `step, t0 = 0, time.time()`,
    `model.train()`,
    `for epoch in range(args.epochs):`,
    `    if world > 1:`,
    `        train_loader.sampler.set_epoch(epoch)  # a different shuffle each epoch, split across GPUs`,
    `    for batch in train_loader:`,
    `        x, y = unpack(batch)`,
    `        with torch.autocast(device_type, dtype=amp, enabled=amp != torch.float32):`,
    `            out = model(x)`,
    `        loss, c, k = step_loss(out, x, y)`,
    `        opt.zero_grad(set_to_none=True)`,
    `        loss.backward()`,
    `        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)`,
    `        opt.step()`,
    `        sched.step()`,
    `        step += 1`,
    `        if run and step % 10 == 0:`,
    `            run.log({"train/loss": loss, ${accuracy ? `"train/accuracy": c / max(k, 1), ` : ""}"lr": sched.get_last_lr()[0], "samples_per_sec": step * args.batch_size * world / (time.time() - t0)}, step=step)`,
    `        if step >= total:`,
    `            break`,
    `    if val_loader is not None and main:`,
    `        metrics = evaluate()`,
    `        if run:`,
    `            run.log(metrics, step=step)`,
    `        print("epoch %d: %s" % (epoch + 1, ", ".join("%s %.4f" % kv for kv in metrics.items())))`,
    `    if step >= total:`,
    `        break`,
    ``,
    ...finalEvaluation(mode, classes),
    ...TAIL(stem),
  ].join("\n");
}

/**
 * After training: score the test split (validation if there's none) and record the examples the
 * model gets most wrong, so the run shows where it fails, not just how often.
 */
function finalEvaluation(mode: Exclude<TrainMode, "diffusion">, classes: number): string[] {
  const perExample: Record<Exclude<TrainMode, "diffusion">, string[]> = {
    classify: [
      `def per_example(out, x, y):  # each example's loss, and whether it got anything wrong`,
      `    b = y.shape[0]`,
      `    o, t = out.float().reshape(-1, ${classes}), y.reshape(-1)`,
      `    loss = nn.functional.cross_entropy(o, t, reduction="none").reshape(b, -1).mean(1)`,
      `    return loss, (o.argmax(-1) != t).reshape(b, -1).any(1)`,
    ],
    binary: [
      `def per_example(out, x, y):  # each example's loss, and whether it got anything wrong`,
      `    b = y.shape[0]`,
      `    o, t = out.float().reshape(b, -1), y.float().reshape(b, -1)`,
      `    loss = nn.functional.binary_cross_entropy_with_logits(o, t, reduction="none").mean(1)`,
      `    return loss, ((o > 0).float() != t).any(1)`,
    ],
    regress: [
      `def per_example(out, x, y):  # each example's squared error; nothing is simply "wrong"`,
      `    y = y.float()`,
      `    return (out.float().reshape(y.shape) - y).pow(2).reshape(y.shape[0], -1).mean(1), None`,
    ],
    reconstruct: [
      `def per_example(out, x, y):  # how badly each example is rebuilt`,
      `    return (out.float() - x.float()).pow(2).reshape(x.shape[0], -1).mean(1), None`,
    ],
  };
  const accuracy = mode === "classify" || mode === "binary";
  return [
    ``,
    ...perExample[mode],
    ``,
    ``,
    `@torch.no_grad()`,
    `def final_evaluation(worst=8):`,
    `    split = "test" if loaders.get("test") is not None else "val" if val_loader is not None else None`,
    `    if split is None:`,
    `        return`,
    `    raw.eval()`,
    `    n = loss_sum = correct = count = wrong = 0`,
    `    keep_l = keep_x = keep_y = None`,
    `    for batch in loaders["test"] if split == "test" else val_loader:`,
    `        x, y = unpack(batch)`,
    `        with torch.autocast(device_type, dtype=amp, enabled=amp != torch.float32):`,
    `            out = raw(x)`,
    `        loss, c, k = step_loss(out, x, y)`,
    `        loss_sum, n = loss_sum + loss.item() * x.size(0), n + x.size(0)`,
    `        correct, count = correct + c, count + k`,
    `        l, w = per_example(out, x, y)`,
    `        if w is not None:`,
    `            wrong += int(w.sum())`,
    `            l = torch.where(w, l, torch.full_like(l, -1.0))  # only mistakes can be "worst"`,
    `        # Keep the worst few seen so far (on the CPU), not the whole split.`,
    `        cand_l = l.cpu() if keep_l is None else torch.cat([keep_l, l.cpu()])`,
    `        cand_x = x.cpu() if keep_x is None else torch.cat([keep_x, x.cpu()])`,
    `        cand_y = None if y is None else y.cpu() if keep_y is None else torch.cat([keep_y, y.cpu()])`,
    `        top = cand_l.topk(min(worst, len(cand_l))).indices`,
    `        keep_l, keep_x = cand_l[top], cand_x[top]`,
    `        keep_y = cand_y[top] if cand_y is not None else None`,
    `    raw.train()`,
    `    if split == "test":`,
    `        metrics = {"test/loss": loss_sum / max(n, 1)}`,
    ...(accuracy ? [`        metrics["test/accuracy"] = correct / max(count, 1)`] : []),
    `        print("test: %s" % ", ".join("%s %.4f" % kv for kv in metrics.items()))`,
    `        if run:`,
    `            run.log(metrics, step=step)`,
    `    if run and keep_l is not None and hasattr(run, "log_failures"):  # older Converlt SDKs don't record them`,
    `        mask = keep_l >= 0  # nothing wrong leaves it empty, and the score is still recorded`,
    `        base = getattr(train_loader.dataset, "dataset", train_loader.dataset)`,
    `        run.log_failures(raw, keep_x[mask], keep_y[mask] if keep_y is not None else None, losses=keep_l[mask], class_names=getattr(base, "classes", None), total=n, wrong=${accuracy ? "wrong" : "None"}, split=split)`,
    ``,
    ``,
    `if main:`,
    `    final_evaluation()`,
  ];
}

/** DDPM on the dataset's examples: noise to a random step t, learn to predict the noise; --sample N draws N at the end. */
function diffusionScript(g: ModelGraph, data: TrainData, stem: string, cls: string): string {
  return [
    ...HEADER(cls, data, "diffusion (DDPM), learning to predict the noise added at a random step", stem),
    ...COMMON(cls, stem, data, ["TIMESTEPS"], "2e-4", [`p.add_argument("--sample", type=int, default=0, help="generate this many examples after training, into samples.pt")`]),
    `sample_n = args.sample`,
    ``,
    `# Linear noise schedule (Ho et al., 2020).`,
    `betas = torch.linspace(1e-4, 0.02, TIMESTEPS, device=device)`,
    `alphas = 1.0 - betas`,
    `alpha_bar = torch.cumprod(alphas, dim=0)`,
    `expand = (1,) * len(INPUT_SHAPE)`,
    ``,
    ``,
    `def scale(x):`,
    data.spec.unitRange ? `    return x.float() * 2 - 1  # images arrive in [0, 1]; diffusion works in [-1, 1]` : `    return x.float()  # used as stored: scale your arrays to about [-1, 1]`,
    ``,
    ``,
    `step, t0 = 0, time.time()`,
    `model.train()`,
    `for epoch in range(args.epochs):`,
    `    if world > 1:`,
    `        train_loader.sampler.set_epoch(epoch)  # a different shuffle each epoch, split across GPUs`,
    `    for batch in train_loader:`,
    `        x0 = scale(unpack(batch)[0])`,
    `        t = torch.randint(0, TIMESTEPS, (x0.size(0),), device=device)`,
    `        noise = torch.randn_like(x0)`,
    `        ab = alpha_bar[t].view(-1, *expand)`,
    `        xt = ab.sqrt() * x0 + (1 - ab).sqrt() * noise`,
    `        with torch.autocast(device_type, dtype=amp, enabled=amp != torch.float32):`,
    `            loss = nn.functional.mse_loss(model(xt, t).float(), noise)`,
    `        opt.zero_grad(set_to_none=True)`,
    `        loss.backward()`,
    `        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)`,
    `        opt.step()`,
    `        sched.step()`,
    `        step += 1`,
    `        if run and step % 10 == 0:`,
    `            run.log({"train/loss": loss, "lr": sched.get_last_lr()[0], "samples_per_sec": step * args.batch_size * world / (time.time() - t0)}, step=step)`,
    `        if step >= total:`,
    `            break`,
    `    if main:`,
    `        print("epoch %d: loss %.4f" % (epoch + 1, loss.item()))`,
    `    if step >= total:`,
    `        break`,
    ...TAIL(stem),
    `if sample_n and main:`,
    `    raw.eval()`,
    `    x = torch.randn(sample_n, *INPUT_SHAPE, device=device)`,
    `    with torch.no_grad():`,
    `        for i in reversed(range(TIMESTEPS)):`,
    `            t = torch.full((sample_n,), i, device=device, dtype=torch.long)`,
    `            eps = raw(x, t).float()`,
    `            x = (x - betas[i] / (1 - alpha_bar[i]).sqrt() * eps) / alphas[i].sqrt()`,
    `            if i > 0:`,
    `                x = x + betas[i].sqrt() * torch.randn_like(x)`,
    `    torch.save(x.clamp(-1, 1).cpu(), "samples.pt")`,
    `    print("saved %d samples to samples.pt" % sample_n)`,
    ``,
  ].join("\n");
}
