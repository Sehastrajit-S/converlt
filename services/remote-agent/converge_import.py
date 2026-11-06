#!/usr/bin/env python3
"""Turns a PyTorch nn.Module into a Converlt Model Builder graph.

    converge_import.py < payload.json

The payload holds the project's Python files (so the model's own imports work), the file and
class to import, and an example input shape. The model is traced with torch.fx and run once on
an example batch (ShapeProp), so every node has its real output shape. Modules and functions the
builder knows become builder layers with their settings; anything else becomes a "Custom" block
that keeps its real shape and parameter count. Prints one JSON line.
"""

import importlib
import json
import operator
import os
import sys
import tempfile
import traceback


def emit(obj):
    sys.stdout.write(json.dumps(obj, default=str) + "\n")


def load_module(payload):
    root = tempfile.mkdtemp(prefix="converlt-import-")
    for rel, src in payload["files"].items():
        path = os.path.join(root, *rel.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(src)
    sys.path.insert(0, root)
    name = payload["file"][:-3].replace("/", ".")
    return importlib.import_module(name)


def module_classes(mod):
    import torch.nn as nn

    return [k for k, v in vars(mod).items() if isinstance(v, type) and issubclass(v, nn.Module) and v.__module__ == mod.__name__]


def main():
    payload = json.loads(sys.stdin.read())
    try:
        import torch  # noqa: F401
    except ImportError:
        emit({"ok": False, "error": "PyTorch isn't installed in this machine's Python, so the model can't be traced."})
        return
    try:
        mod = load_module(payload)
    except Exception as e:
        emit({"ok": False, "error": "Couldn't import %s: %s: %s" % (payload["file"], type(e).__name__, e), "trace": traceback.format_exc()[-2500:]})
        return
    classes = module_classes(mod)
    shape = payload.get("inputShape") or list(getattr(mod, "INPUT_SHAPE", None) or [])
    base = {"ok": True, "classes": classes, "inputShape": shape or None, "inputDtype": "long" if str(getattr(mod, "INPUT_DTYPE", "")) == "torch.int64" else None}
    name = payload.get("className") or (classes[0] if len(classes) == 1 else None)
    if not name or not shape:
        base.update(graph=None, need="class" if not name else "shape")
        emit(base)
        return
    try:
        base.update(convert(mod, name, shape, payload.get("dtype") or base["inputDtype"] or "float", payload.get("timesteps")))
    except Exception as e:
        base.update(ok=False, error="%s: %s" % (type(e).__name__, e), trace=traceback.format_exc()[-2500:])
    emit(base)


# ---------------------------------------------------------------- conversion


ACT = {"ReLU", "GELU", "SiLU", "Tanh", "Sigmoid"}


def one(v):
    """An int from an int or a tuple of equal ints; None when they differ."""
    if isinstance(v, int):
        return v
    if isinstance(v, (tuple, list)) and v and all(x == v[0] for x in v) and isinstance(v[0], int):
        return v[0]
    return None


def map_module(m):
    """(builder type, params) for a module the builder can express, else None."""
    import torch.nn as nn

    t = type(m).__name__
    if t == "TimestepEmbedding" and hasattr(m, "dim"):
        return "Timestep", {"dim": int(m.dim)}
    if isinstance(m, nn.Linear):
        return "Linear", {"out_features": m.out_features, "bias": m.bias is not None}
    if isinstance(m, (nn.Conv1d, nn.Conv2d, nn.Conv3d)):
        k, s, d = one(m.kernel_size), one(m.stride), one(m.dilation)
        p = one(m.padding) if not isinstance(m.padding, str) else None
        if None in (k, s, d, p) or m.padding_mode != "zeros" or (m.groups != 1 and not isinstance(m, nn.Conv2d)):
            return None
        params = {"out_channels": m.out_channels, "kernel_size": k, "stride": s, "padding": p, "dilation": d, "bias": m.bias is not None}
        if isinstance(m, nn.Conv2d):
            params["groups"] = m.groups
        return t, params
    if isinstance(m, nn.ConvTranspose2d):
        k, s, p = one(m.kernel_size), one(m.stride), one(m.padding)
        if None in (k, s, p) or one(m.output_padding) != 0 or m.groups != 1 or one(m.dilation) != 1:
            return None
        return "ConvTranspose2d", {"out_channels": m.out_channels, "kernel_size": k, "stride": s, "padding": p, "bias": m.bias is not None}
    if isinstance(m, (nn.BatchNorm1d, nn.BatchNorm2d, nn.BatchNorm3d)) and m.affine:
        return "BatchNorm", {}
    if isinstance(m, nn.LayerNorm) and len(m.normalized_shape) == 1 and m.elementwise_affine:
        return "LayerNorm", {}
    if isinstance(m, (nn.Dropout, nn.Dropout1d, nn.Dropout2d, nn.Dropout3d)):
        return "Dropout", {"p": float(m.p)}
    if t in ACT:
        return t, {}
    if isinstance(m, nn.LeakyReLU):
        return "LeakyReLU", {"negative_slope": float(m.negative_slope)}
    if isinstance(m, nn.Softmax) and m.dim in (-1, None):
        return "Softmax", {}
    if isinstance(m, (nn.MaxPool1d, nn.MaxPool2d, nn.MaxPool3d, nn.AvgPool2d)):
        k, s, p = one(m.kernel_size), one(m.stride if m.stride is not None else m.kernel_size), one(m.padding)
        if None in (k, s, p) or getattr(m, "ceil_mode", False) or one(getattr(m, "dilation", 1)) != 1 or (p and isinstance(m, nn.AvgPool2d) and not m.count_include_pad):
            return None
        return t, {"kernel_size": k, "stride": s, "padding": p}
    if isinstance(m, (nn.AdaptiveAvgPool1d, nn.AdaptiveAvgPool2d)):
        o = one(m.output_size)
        return (t, {"output_size": o}) if o else None
    if isinstance(m, nn.AdaptiveAvgPool3d):
        o = m.output_size if isinstance(m.output_size, (tuple, list)) else (m.output_size,) * 3
        return ("AdaptiveAvgPool3d", {"time_size": o[0], "output_size": o[1]}) if o[1] == o[2] and None not in o else None
    if isinstance(m, nn.Flatten) and m.start_dim == 1 and m.end_dim == -1:
        return "Flatten", {}
    if isinstance(m, nn.Embedding):
        return "Embedding", {"num_embeddings": m.num_embeddings, "embedding_dim": m.embedding_dim}
    if isinstance(m, (nn.LSTM, nn.GRU)) and m.batch_first and m.bias and not getattr(m, "proj_size", 0):
        return t, {"hidden_size": m.hidden_size, "num_layers": m.num_layers, "bidirectional": bool(m.bidirectional)}
    if isinstance(m, nn.MultiheadAttention) and m.batch_first and m._qkv_same_embed_dim and m.in_proj_bias is not None:
        return "MultiheadAttention", {"num_heads": m.num_heads}
    if isinstance(m, nn.TransformerEncoderLayer) and m.self_attn.batch_first and m.norm_first and m.activation_relu_or_gelu == 1:
        return "TransformerEncoderLayer", {"nhead": m.self_attn.num_heads, "dim_feedforward": m.linear1.out_features, "dropout": float(m.dropout.p)}
    if isinstance(m, nn.Upsample) and m.mode == "nearest" and isinstance(m.scale_factor, (int, float)) and float(m.scale_factor).is_integer():
        return "Upsample", {"scale_factor": int(m.scale_factor)}
    return None


def convert(mod, class_name, shape, dtype, timesteps):
    import torch
    import torch.fx as fx
    import torch.nn as nn
    from torch.fx.passes.shape_prop import ShapeProp

    cls = getattr(mod, class_name, None)
    if cls is None:
        raise ValueError("%s isn't defined in this file" % class_name)
    try:
        model = cls()
    except TypeError as e:
        raise ValueError("%s() needs arguments (%s). Only models that build with defaults can be imported." % (class_name, e))
    model.eval()

    class Tracer(fx.Tracer):
        def is_leaf_module(self, m, qualname):
            return type(m).__name__ == "TimestepEmbedding" or super().is_leaf_module(m, qualname)

    graph = Tracer().trace(model)
    gm = fx.GraphModule(model, graph)
    placeholders = [n for n in gm.graph.nodes if n.op == "placeholder"]
    vocab = min([m.num_embeddings for m in model.modules() if isinstance(m, nn.Embedding)] or [100])
    x = torch.randint(0, vocab, (2, *shape)) if dtype == "long" else torch.randn(2, *shape)
    args = [x]
    for _ in placeholders[1:]:
        args.append(torch.randint(0, timesteps or 1000, (2,)))
    with torch.no_grad():
        ShapeProp(gm).propagate(*args)

    def is_meta(tm):
        # TensorMetadata is itself a NamedTuple, so tell one tensor from a tuple of outputs by its fields.
        return tm is not None and hasattr(tm, "shape") and hasattr(tm, "dtype")

    def meta_shape(n):
        tm = n.meta.get("tensor_meta")
        if is_meta(tm):
            return list(tm.shape[1:])
        if isinstance(tm, (tuple, list)) and tm and is_meta(tm[0]):
            return list(tm[0].shape[1:])
        return None

    def is_tensor(n):
        return n.meta.get("tensor_meta") is not None

    # Tensors computed from the model's input. Shapes read off it (x.size(1)) aren't tensors, so
    # what's built from them (causal masks, position ids) counts as a constant.
    live = set()
    time_inputs = set(placeholders[1:])
    for n in gm.graph.nodes:
        if n.op == "placeholder":
            live.add(n)
        elif is_tensor(n) and any(a in live for a in n.all_input_nodes):
            live.add(n)

    nodes, edges, custom, notes = [], [], [], []
    ref = {}  # fx node -> builder node id
    pos_emb = {}  # fx node (embedding of arange) -> its module
    counter = [0]

    def add(type_, params, inputs, fx_node, label=None):
        counter[0] += 1
        nid = "i%d" % counter[0]
        nodes.append({"id": nid, "type": type_, "params": params, "fx": fx_node.name, "label": label})
        for i in inputs:
            if i in ref and (ref[i], nid) not in [(e["from"], e["to"]) for e in edges]:
                edges.append({"from": ref[i], "to": nid})
        ref[fx_node] = nid
        return nid

    def custom_block(n, what, inputs):
        shape_ = meta_shape(n)
        params = 0
        if n.op == "call_module":
            params = sum(p.numel() for p in gm.get_submodule(n.target).parameters())
        custom.append(what)
        add("Custom", {"what": what, "shape": ",".join(map(str, shape_ or [])), "params": params}, inputs, n, what)

    def tensor_inputs(n):
        return [a for a in n.all_input_nodes if a in ref]

    for n in gm.graph.nodes:
        if n.op == "placeholder":
            if n is placeholders[0]:
                add("Input", {"shape": ",".join(map(str, shape)), "dtype": "token ids" if dtype == "long" else "float"}, [], n)
            continue
        if n.op == "output":
            outs = n.args[0]
            first = outs[0] if isinstance(outs, (tuple, list)) else outs
            if isinstance(outs, (tuple, list)) and len(outs) > 1:
                notes.append("forward() returns %d values; the graph follows the first." % len(outs))
            nid = add("Output", {"loss": "auto"}, [], n)
            if first in ref:
                edges.append({"from": ref[first], "to": nid})
            continue
        if n.op == "get_attr" or not is_tensor(n):
            continue
        ins = tensor_inputs(n)
        # A timestep embedding reads the second forward() argument.
        if n.op == "call_module" and type(gm.get_submodule(n.target)).__name__ == "TimestepEmbedding" and any(a in time_inputs for a in n.all_input_nodes):
            m = gm.get_submodule(n.target)
            add("Timestep", {"dim": int(m.dim), "steps": int(timesteps or getattr(mod, "TIMESTEPS", 1000))}, [], n)
            continue
        if n not in live:
            # Constants, except a learned position table looked up with arange (x + pos(arange)).
            if n.op == "call_module" and isinstance(gm.get_submodule(n.target), nn.Embedding):
                src = n.args[0]
                if getattr(src, "op", None) == "call_function" and getattr(src.target, "__name__", "") == "arange":
                    pos_emb[n] = gm.get_submodule(n.target)
            continue
        if not ins:
            continue
        if n.op == "call_module":
            m = gm.get_submodule(n.target)
            if isinstance(m, nn.Identity):
                ref[n] = ref[ins[0]]
                continue
            mapped = map_module(m)
            if mapped and mapped[0] == "MultiheadAttention" and len({a for a in n.args[:3] if hasattr(a, "op")}) != 1:
                mapped = None  # cross-attention: q, k, v differ
            if mapped and mapped[0] == "TransformerEncoderLayer" and n.kwargs.get("is_causal"):
                mapped[1]["causal"] = True
            if mapped and len(ins) == 1:
                add(mapped[0], mapped[1], ins, n, n.target)
            else:
                custom_block(n, "%s (%s)" % (n.target, type(m).__name__), ins)
            continue
        fn = n.target if n.op == "call_function" else None
        name = getattr(fn, "__name__", "") if fn else n.target
        out_shape = meta_shape(n)
        in_shape = meta_shape(ins[0]) if ins else None
        if name == "getitem":
            idx = n.args[1]
            src_tm = n.args[0].meta.get("tensor_meta") if hasattr(n.args[0], "meta") else None
            if src_tm is not None and not is_meta(src_tm):  # (output, state) from LSTM / attention
                if idx == 0:
                    ref[n] = ref[ins[0]]
                else:
                    notes.append("%s's extra output (index %s) isn't shown: the builder follows the main output." % (n.args[0].name, idx))
                continue
            elif isinstance(idx, tuple) and len(idx) == 2 and idx[0] == slice(None) and idx[1] in (0, -1) and in_shape and len(in_shape) >= 2:
                add("SequencePool", {"mode": "first" if idx[1] == 0 else "last"}, ins, n)
                continue
            custom_block(n, "indexing", ins)
            continue
        if name in ("contiguous", "float", "to", "type_as", "clone", "detach") or (name == "dropout" and fn is None):
            ref[n] = ref[ins[0]]
            continue
        if name in ("add", "iadd", "__add__"):
            others = [a for a in n.args if hasattr(a, "op")]
            pe = [a for a in others if a in pos_emb]
            if pe and len(ins) == 1:
                add("PositionEmbedding", {}, ins, n, pe[0].target)
                continue
            if len(ins) >= 2 and len(others) == len(ins):
                add("Add", {}, ins, n)
                continue
            custom_block(n, "add a constant", ins)
            continue
        if name == "cat":
            d = n.args[1] if len(n.args) > 1 else n.kwargs.get("dim", 0)
            if isinstance(d, int) and d != 0 and in_shape is not None:
                add("Concat", {"dim": d - 1 if d > 0 else d}, ins, n)
            else:
                custom_block(n, "concatenate", ins)
            continue
        if name in ("relu", "gelu", "silu", "tanh", "sigmoid"):
            add({"relu": "ReLU", "gelu": "GELU", "silu": "SiLU", "tanh": "Tanh", "sigmoid": "Sigmoid"}[name], {}, ins, n)
            continue
        if name == "leaky_relu":
            add("LeakyReLU", {"negative_slope": float(n.kwargs.get("negative_slope", n.args[1] if len(n.args) > 1 else 0.01))}, ins, n)
            continue
        if name == "softmax" and (n.kwargs.get("dim", n.args[1] if len(n.args) > 1 else None) in (-1, len(out_shape or []))):
            add("Softmax", {}, ins, n)
            continue
        if name in ("adaptive_avg_pool1d", "adaptive_avg_pool2d"):
            o = one(n.args[1] if len(n.args) > 1 else n.kwargs.get("output_size"))
            if o:
                add("AdaptiveAvgPool1d" if name.endswith("1d") else "AdaptiveAvgPool2d", {"output_size": o}, ins, n)
                continue
        if name in ("max_pool1d", "max_pool2d", "max_pool3d", "avg_pool2d"):
            a = list(n.args[1:]) + [None] * 3
            k = one(a[0] if a[0] is not None else n.kwargs.get("kernel_size"))
            s = n.kwargs.get("stride", a[1])
            s = one(s) if s is not None else k
            p = one(n.kwargs.get("padding", a[2] if a[2] is not None else 0))
            if None not in (k, s, p) and not n.kwargs.get("ceil_mode") and one(n.kwargs.get("dilation", 1)) == 1:
                add({"max_pool1d": "MaxPool1d", "max_pool2d": "MaxPool2d", "max_pool3d": "MaxPool3d", "avg_pool2d": "AvgPool2d"}[name], {"kernel_size": k, "stride": s, "padding": p}, ins, n)
                continue
        if name == "dropout":
            add("Dropout", {"p": float(n.kwargs.get("p", n.args[1] if len(n.args) > 1 else 0.5))}, ins, n)
            continue
        if name == "mean" and in_shape and len(in_shape) >= 2 and (n.args[1:2] == (1,) or n.kwargs.get("dim") == 1) and not n.kwargs.get("keepdim"):
            add("SequencePool", {"mode": "mean"}, ins, n)
            continue
        feeds_add = bool(n.users) and all(getattr(u.target, "__name__", u.target) in ("add", "iadd", "__add__") for u in n.users)
        if name in ("view", "reshape", "unsqueeze") and feeds_add and in_shape is not None and len(in_shape) == 1 and out_shape and [d for d in out_shape if d != 1] == in_shape:
            # A vector shaped for broadcasting ([C] -> [C, 1, 1]); the builder's Add broadcasts vectors itself.
            ref[n] = ref[ins[0]]
            continue
        if name in ("flatten", "view", "reshape", "unsqueeze", "squeeze") and out_shape is not None:
            if len(out_shape) == 1 and name in ("flatten", "view", "reshape"):
                add("Flatten", {}, ins, n)
            else:
                add("Reshape", {"shape": ",".join(map(str, out_shape))}, ins, n)
            continue
        if name == "permute":
            dims = list(n.args[1:]) if len(n.args) > 2 else list(n.args[1])
            if dims and dims[0] == 0:
                add("Permute", {"order": ",".join(str(d - 1) for d in dims[1:])}, ins, n)
                continue
        if name == "transpose" and in_shape is not None:
            a, b = n.args[1], n.args[2]
            r = len(in_shape) + 1
            a, b = a % r, b % r
            if 0 not in (a, b):
                order = list(range(r))
                order[a], order[b] = order[b], order[a]
                add("Permute", {"order": ",".join(str(d - 1) for d in order[1:])}, ins, n)
                continue
        custom_block(n, name if isinstance(name, str) else str(name), ins)

    torch_params = sum(p.numel() for p in model.parameters())
    return {"graph": {"name": class_name, "nodes": nodes, "edges": edges}, "torchParams": torch_params, "custom": custom, "notes": notes}


if __name__ == "__main__":
    main()
