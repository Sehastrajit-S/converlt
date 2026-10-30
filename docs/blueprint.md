# Converlt — Complete Product Blueprint



Product Strategy

Technical Architecture

18-Month Roadmap



# Converlt

The ML-native development environment

## From your first training run to your best model. One workspace.

Converlt brings code editing, remote GPUs, training diagnostics, experiment tracking, data inspection, and ML-aware AI assistance into a unified development experience.

PyTorch-first

Cloud-agnostic

Local-first

AI-native

## 1. Product vision

Converlt should become the development environment ML engineers open when they start work—not another dashboard they remember to check after training finishes.

Consider a typical ML engineer's workflow:

1. Write model code in VS Code or Cursor.
2. Connect to a GPU machine using SSH.
3. Configure Python, CUDA, and dependencies.
4. Start a training run.
5. Check logs for failures.
6. Switch to W&B or MLflow to inspect metrics.
7. Open another terminal to check GPU memory.
8. Edit the code and run another experiment.
9. Manually compare results.
10. Repeat.

The real opportunity is connecting these steps so the engineer retains context throughout the development process.

### The product's three promises

Develop without infrastructure friction

Run code on available GPU hardware without repeatedly configuring remote machines and development environments.

Understand what happens during training

Surface failures, tensor problems, memory usage, performance bottlenecks, and training behavior alongside the relevant code.

Make every experiment useful

Preserve code, parameters, metrics, artifacts, and decisions so every new experiment builds on previous work.

## 2. Product structure

I recommend organizing Converlt into six connected products rather than a collection of unrelated features.

## Converlt IDE

The developer's primary workspace

Compute

GPU execution and cost

Experiments

Runs, metrics, and history

Debug

Training diagnostics

Data

Datasets and error analysis

Intelligence

ML-aware AI agent

Deploy

Model export and serving

All six modules should share a common object: the Converlt Run.

A run should connect:

- The exact code and configuration used.
- The dataset reference.
- The execution environment.
- The GPU machine.
- Training logs and metrics.
- Errors, diagnostics, and profiler results.
- Produced checkpoints.
- The experiment's intent and conclusions.

This shared run model is the architectural foundation of the product.

## 3. Feature prioritization

The full vision is substantial. The key is deciding which features produce value immediately and which require a mature runtime.

Explore feature releases

6 features

MVPV1V2Enterprise

Code editor integration

P0

VS Code extension, workspace panel, run commands

Connect an existing GPU

P0

SSH connection and remote runner

GPU telemetry

P0

Memory, utilization, machine status

Run history

P0

Code, config, status, logs and metrics

Basic run comparison

P0

Overlay metrics and inspect config differences

Failure detection

P0

NaN, OOM, exit errors and alerts

This is the proposed order, not a commitment to implement every feature. Customer validation should determine which V1 and V2 capabilities earn their place.

# Part I — Detailed Feature Specifications

## 4. Converlt IDE: The developer workspace

MVP foundation

The initial interface should feel familiar to anyone who has used VS Code, with additional ML-specific controls.

### Proposed workspace

CONVERGE

train.py

EXPLORER

&#x20;resnet-project

　 train.py

　 model.py

　 config.yaml

EXPERIMENTS

&#x20;run-042

&#x20;run-043

&#x20;run-041

train.py

PyTorch

01  import torch

02  model = ResNet().cuda()

03  optimizer = AdamW(...)

04  for batch in loader:

05      logits = model(batch)

06      loss.backward()

07      optimizer.step()

Training active

Step 1,240 / 5,000 · Loss 0.328

&#x20;A100 40GB

VRAM 24/40 GB

$1.20/hr

● Running

Conceptual interface layout. Not a functional prototype.

### Core interface components

| Component        | Purpose                                            |
| ---------------- | -------------------------------------------------- |
| Project Explorer | Source code, configurations, datasets              |
| Compute Explorer | Available local and remote GPU machines            |
| Runs Explorer    | Training jobs and experiment history               |
| Training Panel   | Live metrics, logs, progress, diagnostics          |
| GPU Status Bar   | Device status, memory, utilization, estimated cost |
| Compare View     | Side-by-side run comparisons                       |
| Converlt AI      | Context-aware assistant for ML development         |

### MVP acceptance criteria

- A developer can open an existing PyTorch repository without reorganizing it.
- They can connect an existing Linux GPU machine using SSH.
- They can start, monitor, cancel, and inspect a training command.
- They can close the editor without killing a properly detached remote job.
- Their runs remain accessible after reopening the project.
- If the Converlt service becomes unavailable, ordinary editing and existing training processes continue to work.

That last requirement is especially important. Converlt should never become a single point of failure for model training.

## 5. Converlt Compute: GPU development anywhere



P0: Connect existing GPUs

P1: Provision new GPUs



This is likely Converlt's most valuable initial feature.

### User story

An engineer has a laptop without a powerful GPU. They want to train a PyTorch model on an A100 without abandoning their preferred development environment.

They open the Converlt panel, choose a machine, and click Run.

### GPU selection interface

Select training hardware

Illustrative UI

Local GPU24 GB VRAMOwnedNVIDIA L424 GB VRAM$0.70/hrNVIDIA A10040 GB VRAM$1.50/hrNVIDIA H10080 GB VRAM$3.20/hr

Estimated training hours

8h

Estimated selected compute cost

# $12.00

Example rates only—not live provider prices. Local power and hardware costs are excluded.

Explore launch workflow

### Feature specifications

A. Machine connections

- Register a local, SSH-accessible, or cloud-hosted GPU machine.
- Verify GPU visibility, CUDA compatibility, Python availability, storage, and working directory.
- Show environment readiness before launching.
- Support key-based SSH authentication.
- Store credentials using secure platform facilities, never inside project configuration files.
- Display connection health and actionable errors.

B. Remote execution

- Launch Python training commands from the editor.
- Stream logs with reconnection and resume support.
- Synchronize selected source files.
- Exclude large datasets, credentials, checkpoints, and ignored files by default.
- Maintain a stable run identity even if the editor disconnects.
- Provide explicit stop, terminate, and detach operations.

C. GPU telemetry

- Device model and driver version.
- Allocated and used VRAM.
- GPU utilization and temperature where supported.
- CPU and RAM usage.
- Disk capacity and availability.
- Running process identity.
- Estimated hourly and accumulated costs.

D. Cost management

- Budget limits per run and project.
- Alerts at configurable spending thresholds.
- Idle-machine detection.
- Automatic shutdown of Converlt-managed idle instances.
- A distinction between shutting down compute and terminating a training process.
- Estimated versus provider-billed costs displayed separately.

E. Cloud provisioning — V1

Initially support only two pathways:

1. Bring an existing GPU through SSH.
2. Launch a GPU from one supported provider.

I would start with RunPod or AWS, depending on which your first pilot customers already use. Add provider abstraction after validating the first integration.

### Important technical requirement

Remote training should use an independently supervised process. The IDE is only a controller and observer. Losing the WebSocket connection must never automatically terminate training.

## 6. Converlt Experiments: Every run remembered

P0

This module should be built alongside remote execution.

### What happens when the engineer clicks Run?

Converlt creates an immutable run manifest containing:

| Field               | Example                               |
| ------------------- | ------------------------------------- |
| Run ID              | `run_00042`                           |
| Project             | `image-classifier`                    |
| Git commit          | `abc1234`                             |
| Uncommitted changes | Diff snapshot                         |
| Command             | `python train.py --lr 0.0001`         |
| Framework           | PyTorch                               |
| Environment         | Python/CUDA/package fingerprint       |
| Data reference      | Dataset URI + version/hash if known   |
| GPU                 | A100 40GB                             |
| Hyperparameters     | Learning rate, batch size, epochs     |
| Status              | Running, failed, completed, cancelled |
| Output              | Logs, metrics, checkpoint references  |

### Six essential features

1\. Automatic run capture

Record what can be observed without modifying the training script:

- Command and arguments.
- Git revision and working-tree state.
- Environment details.
- Hardware metadata.
- Start/end timestamps.
- Logs and exit codes.

Metric capture is more complicated: arbitrary training scripts do not share a universal metric interface. Provide structured logging adapters for popular frameworks and a small optional Python SDK.

2\. Run comparison

Select two or more runs to compare:

- Validation accuracy.
- Training loss.
- Runtime.
- GPU memory consumption.
- Configuration differences.
- Code diffs.
- Dataset version.
- Total compute cost.

3\. Experiment intent

Allow users to record:

- Hypothesis.
- Expected outcome.
- Changes being tested.
- Observed result.
- Final conclusion.

4\. Run groups

Organize related runs into experiments such as:

- Batch-size optimization.
- Learning-rate exploration.
- Architecture comparison.
- Dataset ablation.
- Quantization benchmarking.

5\. Checkpoint references

Connect produced checkpoint files to the originating run, with checksums and metadata.

6\. Reproduction

Offer a Reproduce Run action that reconstructs the command and known environment/configuration details, clearly warning when external datasets, nondeterministic operations, unavailable packages, or changed hardware prevent exact reproduction.

### Differentiation

Existing tools already capture metrics, code, and artifacts—W&B, for example, supports code saving and experiment metadata.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://docs.wandb.ai\&sz=32)

Weights & Biases Documentation

[image](https://www.google.com/s2/favicons?domain=https://docs.wandb.ai\&sz=32)

Weights & Biases Documentation



Therefore, Converlt's differentiation cannot simply be “we track experiments.”

It must be the connection between the code being edited, the exact run being executed, the underlying GPU, and the observed results, without leaving the development workflow.

## 7. Converlt Debug: An ML-native training debugger



P0: Failure detection

P1: Deep inspection



Traditional debuggers are designed to explain program state. ML engineers also need to understand the numerical state of training.

### Feature 1: NaN and Inf detection

The user starts training, and Converlt monitors for non-finite loss values.

When a failure is detected, show:

Non-finite training loss detected

Run

`run_042`

Step

`1,284`

Observed value

`NaN`

Last finite loss

`0.347`

Suggested investigation

- Check whether the learning rate changed near this step.
- Inspect gradient norms and non-finite tensors, if instrumentation is enabled.
- Check mixed-precision scaling and recent code changes.

At MVP, detection can produce an error report and optionally stop the run safely.

Later, instrumented training can capture the specific module or operation associated with the first non-finite value.

Do not promise that Converlt can identify the precise root cause of every NaN. Numerical errors often propagate before becoming observable.

### Feature 2: Out-of-memory diagnostics

On a CUDA OOM, show:

- Device memory capacity.
- Current process allocation.
- Peak memory allocation.
- Reserved versus allocated PyTorch memory.
- The failing operation, when observable.
- Batch size and sequence length, when available.
- Practical mitigation suggestions.

PyTorch supports memory snapshots and allocation history, but these primarily describe memory managed by PyTorch's allocator; they do not capture every GPU allocation from every library.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://docs.pytorch.org\&sz=32)

PyTorch 2.14 documentation



### Feature 3: Gradient diagnostics

Add opt-in instrumentation to inspect:

- Gradient norms per layer.
- Non-finite gradients.
- Parameters with missing gradients.
- Unusually small or large gradients.
- Activation statistics for selected modules.

Use configurable sampling so debugging does not introduce unacceptable training overhead.

### Feature 4: Training performance diagnostics

Start with answers to practical questions:

- Is the GPU underutilized?
- Is the dataloader too slow?
- Is GPU memory near its limit?
- Is throughput decreasing?
- Did one code change significantly increase runtime?

Later, integrate detailed PyTorch profiling for operator timing, shapes, and memory statistics. PyTorch already provides a profiler with these capabilities; Converlt should make the results accessible and correlated with the source code.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://docs.pytorch.org\&sz=32)

PyTorch main documentation

[image](https://www.google.com/s2/favicons?domain=https://docs.pytorch.org\&sz=32)

PyTorch Tutorials 2.14.0+cu130 documentation



### Implementation tiers

| Capability                       | MVP                  | Advanced                             |
| -------------------------------- | -------------------- | ------------------------------------ |
| Detect process failures          | Yes                  | Yes                                  |
| Detect NaN loss                  | With instrumentation | Yes                                  |
| CUDA OOM report                  | Basic                | Memory snapshots                     |
| Gradient monitoring              | No                   | Opt-in hooks                         |
| Operator profiling               | No                   | PyTorch profiler                     |
| Break at failing training step   | Limited              | Controlled checkpoints and hooks     |
| Attach to arbitrary live process | No                   | Only supported instrumented runtimes |

Arbitrary mid-training attachment and precise pause/resume are especially challenging. Treat them as research projects rather than guaranteed first-year features.

## 8. Converlt Intelligence: The ML-aware AI agent

V1 core differentiator

This is the feature that can eventually separate Converlt from general AI coding assistants.

A normal coding agent sees files, terminal output, and tool responses. Converlt's AI should additionally have structured access to:

- Experiment history.
- Metrics and checkpoints.
- GPU telemetry.
- Training failures.
- Relevant code/configuration diffs.
- Dataset metadata.
- Profiling evidence.

### Example: Diagnosing training divergence

User:

> Why did my model's validation loss suddenly increase?

The agent should:

1. Identify the active run.
2. Fetch the recent loss history.
3. Find the step at which the increase began.
4. Check nearby learning-rate changes.
5. Inspect warnings and numerical diagnostics.
6. Compare the run to a previous successful experiment.
7. Present evidence-backed hypotheses.
8. Offer a safe follow-up experiment.

A good answer would be:

> Validation loss began increasing after step 1,800. The learning-rate log shows an increase at step 1,750, while the previous successful run used a lower rate. This makes the learning-rate change a plausible contributor, although the available metrics cannot establish causality. Try reproducing the run with the previous schedule.

This is substantially more useful than generic advice about overfitting.

### AI agent capabilities

| Capability                       | Release | Behavior                                |
| -------------------------------- | ------- | --------------------------------------- |
| Explain failures                 | V1      | Analyze run logs and diagnostics        |
| Compare experiments              | V1      | Summarize metrics and changes           |
| Suggest fixes                    | V1      | Generate proposed config/code changes   |
| GPU optimization advice          | V1      | Interpret utilization and memory        |
| Model architecture assistance    | V2      | Inspect models and tensor metadata      |
| Automated sweeps                 | V2      | Propose and execute bounded experiments |
| Dataset error analysis           | V2      | Investigate poor-performing data slices |
| Autonomous training optimization | Later   | Controlled multi-run optimization       |

### Agent permission model

This is non-negotiable: reading information and spending money are different permissions.

Default: Read-only

The agent may inspect code, metrics, logs, and authorized metadata.

Approval: Code changes

The agent proposes diffs, and the user approves modifications.

Explicit authorization: Compute

New GPU jobs require an authorized provider, hardware specification, and budget.

Restricted operations

Credential access, destructive file operations, external data uploads, and deployment changes require separate safeguards and permissions.

For budgeted sweeps, user approval should produce a bounded execution authorization:

```
{
  "objective": "minimize_validation_loss",
  "max_spend_usd": 40,
  "max_trials": 12,
  "max_parallel_jobs": 2,
  "allowed_gpus": ["L4", "A100"],
  "max_duration_minutes": 180,
  "require_approval_for_code_changes": true
}
```

The backend—not the language model—must enforce these limits.

### Agent architecture

I would use a tool-calling agent with narrowly scoped functions:

```
get_run_metrics
get_run_logs
compare_runs
inspect_gpu
inspect_training_environment
get_code_diff
get_checkpoint_metadata
propose_code_patch
propose_experiment
launch_approved_experiment
```

Every response should distinguish:

- Observed facts.
- Inferences.
- Unknowns.
- Suggested actions.

This avoids presenting a plausible explanation as a proven diagnosis.

## 9. Converlt Data: Integrated dataset workbench

V2

The data workbench should focus on datasets directly related to training runs. It should not attempt to replace every data engineering tool.

### Supported dataset types

| Data type     | Initial capabilities              |
| ------------- | --------------------------------- |
| CSV / Parquet | Schema, rows, filters, statistics |
| Images        | Thumbnails, labels, dimensions    |
| Text / JSONL  | Document and token inspection     |
| Audio         | Waveform and metadata             |
| Video         | Frames, clips, metadata           |
| Embeddings    | Similarity search and projections |

### Highest-value feature: Error analysis

Suppose a computer vision model achieves 92% overall accuracy but performs poorly on a specific category.

The engineer should be able to:

1. Open the model's evaluation run.
2. Select a confusion-matrix cell.
3. View the relevant misclassified samples.
4. Filter by attributes such as category, lighting, or source.
5. Compare predictions from two checkpoints.
6. Save the problematic slice as an evaluation dataset.

This requires a link between prediction records and dataset sample IDs. Converlt can support it through an SDK or import format.

### Important implementation decision

Do not automatically upload full datasets to Converlt.

Use:

- Local or remote indexing.
- Lazy row/sample retrieval.
- Object-storage references.
- Opt-in cached previews.
- Explicit permission for transferring sensitive data.

That reduces bandwidth, privacy risk, and storage costs.

## 10. Converlt Model: Architecture and tensor intelligence

V2 / Research-intensive

This could become one of Converlt's most distinctive features, but it requires careful technical design.

### Tensor-aware editing

Imagine opening:

```
x = embedding(input_ids)x = attention(x)logits = classifier(x)
```

The editor might show captured shapes:

```
embedding(x)   → [B, 512, 768]
attention(x)   → [B, 512, 768]
classifier(x)  → [B, 512, 32000]
```

Converlt should offer two complementary mechanisms.

Static inference

- Identify known tensor operations.
- Infer shapes when dimensions and operations are statically available.
- Warn about obvious incompatible matrix dimensions.
- Integrate with Python type checking.

Runtime observations

- Capture shapes from actual execution.
- Associate observed tensor metadata with source locations.
- Display device and dtype information.
- Mark metadata with the run it came from.

Static inference is inherently incomplete because Python programs may create dynamic shapes, branches, and custom operations.

Runtime observations are more reliable for the execution that produced them, but cannot guarantee behavior for every input.

### Model graph explorer

The user should be able to:

- Visualize supported model graphs.
- Inspect layers, parameters, shapes, and device placement.
- Select a node and navigate to the relevant code.
- Compare graph structure between model versions.
- Highlight modules associated with profiler events.

Use available PyTorch tracing/export mechanisms where appropriate, with graceful fallback for models that cannot be fully captured.

### OOM predictor

I would initially call this a memory estimator, not a predictor.

Show:

- Observed peak memory from previous runs.
- Estimated scaling with batch size or sequence length.
- Available GPU memory.
- An uncertainty range.
- Clear warnings about unmodeled allocations, fragmentation, compilation, and dynamic workloads.

A claim like “maximum batch size is exactly 48” would be unreliable across many models. A calibrated estimate with a test-run option is more defensible.

## 11. Converlt Deploy: From checkpoint to serving

Later-stage expansion

Deployment is valuable, but it broadens Converlt beyond training and debugging. I would implement it only after the core developer experience has traction.

### Proposed capabilities

1. Checkpoint inspector: Metadata, parameter counts, sizes, tensor statistics, and checkpoint differences.
2. Model export: Supported export paths such as ONNX, with validation against the source model.
3. Optimization: Supported quantization and compilation workflows, with hardware and compatibility checks.
4. Benchmarking: Latency, throughput, memory use, and accuracy comparison where evaluation data is provided.
5. Deployment: Integrations with established serving systems.
6. Monitoring: Link deployment metrics back to the original experiment and model artifact.

Converlt should initially orchestrate existing deployment tools instead of operating its own full model-serving platform.

# Part II — Technical Architecture

## 12. Recommended architecture

I would build Converlt as four cooperating systems:

\#chatgpt-mermaid-\_r_1j8\_{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;fill:rgb(237, 237, 237);}@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}@keyframes dash{to{stroke-dashoffset:0;}}#chatgpt-mermaid-\_r_1j8\_ .edge-animation-slow{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 50s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_1j8\_ .edge-animation-fast{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 20s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_1j8\_ .error-icon{fill:rgb(48, 48, 48);}#chatgpt-mermaid-\_r_1j8\_ .error-text{fill:rgb(237, 237, 237);stroke:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_1j8\_ .edge-thickness-normal{stroke-width:1px;}#chatgpt-mermaid-\_r_1j8\_ .edge-thickness-thick{stroke-width:3.5px;}#chatgpt-mermaid-\_r_1j8\_ .edge-pattern-solid{stroke-dasharray:0;}#chatgpt-mermaid-\_r_1j8\_ .edge-thickness-invisible{stroke-width:0;fill:none;}#chatgpt-mermaid-\_r_1j8\_ .edge-pattern-dashed{stroke-dasharray:3;}#chatgpt-mermaid-\_r_1j8\_ .edge-pattern-dotted{stroke-dasharray:2;}#chatgpt-mermaid-\_r_1j8\_ .marker{fill:rgb(175, 175, 175);stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_1j8\_ .marker.cross{stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_1j8\_ svg{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;}#chatgpt-mermaid-\_r_1j8\_ p{margin:0;}#chatgpt-mermaid-\_r_1j8\_ .label{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_1j8\_ .cluster-label text{fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_1j8\_ .cluster-label span{color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_1j8\_ .cluster-label span p{background-color:transparent;}#chatgpt-mermaid-\_r_1j8\_ .label text,#chatgpt-mermaid-\_r_1j8\_ span{fill:rgb(237, 237, 237);color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_1j8\_ .node rect,#chatgpt-mermaid-\_r_1j8\_ .node circle,#chatgpt-mermaid-\_r_1j8\_ .node ellipse,#chatgpt-mermaid-\_r_1j8\_ .node polygon,#chatgpt-mermaid-\_r_1j8\_ .node path{fill:rgb(9, 23, 44);stroke:rgb(31, 78, 148);stroke-width:1px;}#chatgpt-mermaid-\_r_1j8\_ .rough-node .label text,#chatgpt-mermaid-\_r_1j8\_ .node .label text,#chatgpt-mermaid-\_r_1j8\_ .image-shape .label,#chatgpt-mermaid-\_r_1j8\_ .icon-shape .label{text-anchor:middle;}#chatgpt-mermaid-\_r_1j8\_ .node .katex path{fill:#000;stroke:#000;stroke-width:1px;}#chatgpt-mermaid-\_r_1j8\_ .rough-node .label,#chatgpt-mermaid-\_r_1j8\_ .node .label,#chatgpt-mermaid-\_r_1j8\_ .image-shape .label,#chatgpt-mermaid-\_r_1j8\_ .icon-shape .label{text-align:center;}#chatgpt-mermaid-\_r_1j8\_ .node.clickable{cursor:pointer;}#chatgpt-mermaid-\_r_1j8\_ .root .anchor path{fill:rgb(175, 175, 175)!important;stroke-width:0;stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_1j8\_ .arrowheadPath{fill:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_1j8\_ .edgePath .path{stroke:rgb(175, 175, 175);stroke-width:1px;}#chatgpt-mermaid-\_r_1j8\_ .flowchart-link{stroke:rgb(175, 175, 175);fill:none;}#chatgpt-mermaid-\_r_1j8\_ .edgeLabel{background-color:rgb(0, 0, 0);text-align:center;}#chatgpt-mermaid-\_r_1j8\_ .edgeLabel p{background-color:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_1j8\_ .edgeLabel rect{opacity:0.5;background-color:rgb(0, 0, 0);fill:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_1j8\_ .labelBkg{background-color:rgba(0, 0, 0, 0.5);}#chatgpt-mermaid-\_r_1j8\_ .cluster rect{fill:rgb(48, 48, 48);stroke:rgba(255, 255, 255, 0.15);stroke-width:1px;}#chatgpt-mermaid-\_r_1j8\_ .cluster text{fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_1j8\_ .cluster span{color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_1j8\_ div.mermaidTooltip{position:absolute;text-align:center;max-width:200px;padding:2px;font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:12px;background:rgb(48, 48, 48);border:1px solid rgba(255, 255, 255, 0.15);border-radius:2px;pointer-events:none;z-index:100;}#chatgpt-mermaid-\_r_1j8\_ .flowchartTitleText{text-anchor:middle;font-size:18px;fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_1j8\_ rect.text{fill:none;stroke-width:0;}#chatgpt-mermaid-\_r_1j8\_ .icon-shape,#chatgpt-mermaid-\_r_1j8\_ .image-shape{background-color:rgb(0, 0, 0);text-align:center;}#chatgpt-mermaid-\_r_1j8\_ .icon-shape p,#chatgpt-mermaid-\_r_1j8\_ .image-shape p{background-color:rgb(0, 0, 0);padding:2px;}#chatgpt-mermaid-\_r_1j8\_ .icon-shape .label rect,#chatgpt-mermaid-\_r_1j8\_ .image-shape .label rect{opacity:0.5;background-color:rgb(0, 0, 0);fill:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_1j8\_ .label-icon{display:inline-block;height:1em;overflow:visible;vertical-align:-0.125em;}#chatgpt-mermaid-\_r_1j8\_ .node .label-icon path{fill:currentColor;stroke:revert;stroke-width:revert;}#chatgpt-mermaid-\_r_1j8\_ .node .neo-node{stroke:rgb(31, 78, 148);}#chatgpt-mermaid-\_r_1j8\_ [data-look="neo"].node rect,#chatgpt-mermaid-\_r_1j8\_ [data-look="neo"].cluster rect,#chatgpt-mermaid-\_r_1j8\_ [data-look="neo"].node polygon{stroke:url(#chatgpt-mermaid-\_r_1j8\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_1j8\_ [data-look="neo"].swimlane.cluster rect{filter:none;}#chatgpt-mermaid-\_r_1j8\_ [data-look="neo"].node path{stroke:url(#chatgpt-mermaid-\_r_1j8\_-gradient);stroke-width:1px;}#chatgpt-mermaid-\_r_1j8\_ [data-look="neo"].node .outer-path{filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_1j8\_ [data-look="neo"].node .neo-line path{stroke:rgb(31, 78, 148);filter:none;}#chatgpt-mermaid-\_r_1j8\_ [data-look="neo"].node circle{stroke:url(#chatgpt-mermaid-\_r_1j8\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_1j8\_ [data-look="neo"].node circle .state-start{fill:#000000;}#chatgpt-mermaid-\_r_1j8\_ [data-look="neo"].icon-shape .icon{fill:url(#chatgpt-mermaid-\_r_1j8\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_1j8\_ [data-look="neo"].icon-shape .icon-neo path{stroke:url(#chatgpt-mermaid-\_r_1j8\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_1j8\_ .node text{font-size:14px;font-weight:600;letter-spacing:normal;fill:rgb(153, 206, 255);}#chatgpt-mermaid-\_r_1j8\_ .edgeLabels text{font-size:13px;font-weight:600;letter-spacing:-0.08px;fill:rgb(153, 206, 255);}#chatgpt-mermaid-\_r_1j8\_ .node tspan[font-weight="normal"],#chatgpt-mermaid-\_r_1j8\_ .edgeLabels tspan[font-weight="normal"]{font-weight:600;}#chatgpt-mermaid-\_r_1j8\_ .edgeLabel .label rect{opacity:1;rx:13px;ry:13px;fill:rgb(0, 14, 26);stroke:rgb(26, 62, 95);stroke-width:1px;}#chatgpt-mermaid-\_r_1j8\_ .node rect,#chatgpt-mermaid-\_r_1j8\_ .node circle,#chatgpt-mermaid-\_r_1j8\_ .node ellipse,#chatgpt-mermaid-\_r_1j8\_ .node polygon,#chatgpt-mermaid-\_r_1j8\_ .node path{fill:rgb(0, 40, 77);stroke:rgba(255, 255, 255, 0.1);stroke-width:1px;}#chatgpt-mermaid-\_r_1j8\_ .node rect{rx:16px;ry:16px;}#chatgpt-mermaid-\_r_1j8\_ .mermaid-decision .label-container{fill:rgb(0, 14, 26);stroke:rgb(26, 62, 95);stroke-dasharray:2,2;}#chatgpt-mermaid-\_r_1j8\_ .edgePaths .flowchart-link{stroke:rgb(175, 175, 175);stroke-width:1px;stroke-linecap:round;stroke-linejoin:round;}#chatgpt-mermaid-\_r_1j8\_ .marker{fill:rgb(175, 175, 175);stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_1j8\_ :root{--mermaid-font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";}VS Code Extension / Future IDEConverge Control PlaneConverge Remote AgentPython Runtime SDKGPU & ML WorkloadsMetadata and Artifact StorageHTTPS / WebSocketSSH / secure channelRun control and metadataLocal IPCInstrumentationOptional artifact upload

### Component responsibilities

| Component             | Responsibilities                              | Suggested technology                |
| --------------------- | --------------------------------------------- | ----------------------------------- |
| VS Code extension     | Commands, views, run controls, diagnostics    | TypeScript                          |
| Remote agent          | Process lifecycle, telemetry, logs, sync      | Go                                  |
| Runtime SDK           | PyTorch instrumentation and metric capture    | Python                              |
| Control plane         | Projects, teams, runs, authorization, billing | TypeScript or Go                    |
| Metadata DB           | Users, projects, jobs, configurations         | PostgreSQL                          |
| Event storage         | Metrics and telemetry                         | PostgreSQL/Timescale initially      |
| Artifact storage      | Logs, patches, snapshots, checkpoints         | S3-compatible object storage        |
| AI service            | Run-analysis tools and model interaction      | Python or TypeScript                |
| Provisioning adapters | Supported cloud providers                     | Provider SDKs / orchestration layer |

I would not start with ClickHouse, Kubernetes, and several microservices.

For the MVP, PostgreSQL plus object storage is likely sufficient. Introduce a specialized metrics store when actual query volume demonstrates the need.

## 13. Repository structure

A proposed monorepo:

```
converge/
├── apps/
│   ├── vscode-extension/
│   ├── web-dashboard/
│   └── api/
├── packages/
│   ├── shared-types/
│   ├── run-protocol/
│   └── ui/
├── services/
│   ├── remote-agent/
│   ├── ai-worker/
│   └── provisioning/
├── python/
│   └── converge-runtime/
├── infra/
│   ├── database/
│   └── deployments/
├── examples/
│   ├── pytorch-cifar/
│   └── transformer-finetune/
└── docs/
```

One important simplification: the web dashboard can be deferred until the extension workflow is stable. Initial run history can live in an extension webview.

VS Code supports custom views and webviews, and its extension architecture handles both local and remote extension hosts.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://code.visualstudio.com\&sz=32)

Visual Studio Code Extension API

[image](https://www.google.com/s2/favicons?domain=https://code.visualstudio.com\&sz=32)

Visual Studio Code Extension API



## 14. Core data model

The product should have a small number of well-defined entities.

\#chatgpt-mermaid-\_r_1js\_{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;fill:rgb(237, 237, 237);}@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}@keyframes dash{to{stroke-dashoffset:0;}}#chatgpt-mermaid-\_r_1js\_ .edge-animation-slow{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 50s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_1js\_ .edge-animation-fast{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 20s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_1js\_ .error-icon{fill:rgb(48, 48, 48);}#chatgpt-mermaid-\_r_1js\_ .error-text{fill:rgb(237, 237, 237);stroke:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_1js\_ .edge-thickness-normal{stroke-width:1px;}#chatgpt-mermaid-\_r_1js\_ .edge-thickness-thick{stroke-width:3.5px;}#chatgpt-mermaid-\_r_1js\_ .edge-pattern-solid{stroke-dasharray:0;}#chatgpt-mermaid-\_r_1js\_ .edge-thickness-invisible{stroke-width:0;fill:none;}#chatgpt-mermaid-\_r_1js\_ .edge-pattern-dashed{stroke-dasharray:3;}#chatgpt-mermaid-\_r_1js\_ .edge-pattern-dotted{stroke-dasharray:2;}#chatgpt-mermaid-\_r_1js\_ .marker{fill:rgb(175, 175, 175);stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_1js\_ .marker.cross{stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_1js\_ svg{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;}#chatgpt-mermaid-\_r_1js\_ p{margin:0;}#chatgpt-mermaid-\_r_1js\_ .entityBox{fill:rgb(9, 23, 44);stroke:rgb(31, 78, 148);}#chatgpt-mermaid-\_r_1js\_ .relationshipLabelBox{fill:rgb(48, 48, 48);opacity:0.7;background-color:rgb(48, 48, 48);}#chatgpt-mermaid-\_r_1js\_ .relationshipLabelBox rect{opacity:0.5;}#chatgpt-mermaid-\_r_1js\_ .labelBkg{background-color:rgba(48, 48, 48, 0.5);}#chatgpt-mermaid-\_r_1js\_ .edgeLabel{background-color:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_1js\_ .edgeLabel .label rect{fill:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_1js\_ .edgeLabel .label text{fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_1js\_ .edgeLabel .label{fill:rgb(31, 78, 148);font-size:14px;}#chatgpt-mermaid-\_r_1js\_ .label{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_1js\_ .edge-pattern-dashed{stroke-dasharray:8,8;}#chatgpt-mermaid-\_r_1js\_ .node rect,#chatgpt-mermaid-\_r_1js\_ .node circle,#chatgpt-mermaid-\_r_1js\_ .node ellipse,#chatgpt-mermaid-\_r_1js\_ .node polygon{fill:rgb(9, 23, 44);stroke:rgb(31, 78, 148);stroke-width:1px;}#chatgpt-mermaid-\_r_1js\_ .relationshipLine{stroke:rgb(175, 175, 175);stroke-width:1px;fill:none;}#chatgpt-mermaid-\_r_1js\_ .marker{fill:none!important;stroke:rgb(175, 175, 175)!important;stroke-width:1;}#chatgpt-mermaid-\_r_1js\_ [data-look=neo].labelBkg{background-color:rgba(48, 48, 48, 0.5);}#chatgpt-mermaid-\_r_1js\_ .node .neo-node{stroke:rgb(31, 78, 148);}#chatgpt-mermaid-\_r_1js\_ [data-look="neo"].node rect,#chatgpt-mermaid-\_r_1js\_ [data-look="neo"].cluster rect,#chatgpt-mermaid-\_r_1js\_ [data-look="neo"].node polygon{stroke:url(#chatgpt-mermaid-\_r_1js\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_1js\_ [data-look="neo"].swimlane.cluster rect{filter:none;}#chatgpt-mermaid-\_r_1js\_ [data-look="neo"].node path{stroke:url(#chatgpt-mermaid-\_r_1js\_-gradient);stroke-width:1px;}#chatgpt-mermaid-\_r_1js\_ [data-look="neo"].node .outer-path{filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_1js\_ [data-look="neo"].node .neo-line path{stroke:rgb(31, 78, 148);filter:none;}#chatgpt-mermaid-\_r_1js\_ [data-look="neo"].node circle{stroke:url(#chatgpt-mermaid-\_r_1js\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_1js\_ [data-look="neo"].node circle .state-start{fill:#000000;}#chatgpt-mermaid-\_r_1js\_ [data-look="neo"].icon-shape .icon{fill:url(#chatgpt-mermaid-\_r_1js\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_1js\_ [data-look="neo"].icon-shape .icon-neo path{stroke:url(#chatgpt-mermaid-\_r_1js\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_1js\_ :root{--mermaid-font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";}ORGANIZATIONPROJECTEXPERIMENTRUNMETRICARTIFACTCOMPUTE_INSTANCEENVIRONMENTDATASET_VERSIONownscontainsgroupsrecordsproducesexecutes_onusesreferences

Every event from the remote agent must carry a run ID and sequence information, allowing the backend to deduplicate reconnects and reconstruct state.

### Run lifecycle

\#chatgpt-mermaid-\_r_1k3\_{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;fill:rgb(237, 237, 237);}@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}@keyframes dash{to{stroke-dashoffset:0;}}#chatgpt-mermaid-\_r_1k3\_ .edge-animation-slow{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 50s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_1k3\_ .edge-animation-fast{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 20s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_1k3\_ .error-icon{fill:rgb(48, 48, 48);}#chatgpt-mermaid-\_r_1k3\_ .error-text{fill:rgb(237, 237, 237);stroke:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_1k3\_ .edge-thickness-normal{stroke-width:1px;}#chatgpt-mermaid-\_r_1k3\_ .edge-thickness-thick{stroke-width:3.5px;}#chatgpt-mermaid-\_r_1k3\_ .edge-pattern-solid{stroke-dasharray:0;}#chatgpt-mermaid-\_r_1k3\_ .edge-thickness-invisible{stroke-width:0;fill:none;}#chatgpt-mermaid-\_r_1k3\_ .edge-pattern-dashed{stroke-dasharray:3;}#chatgpt-mermaid-\_r_1k3\_ .edge-pattern-dotted{stroke-dasharray:2;}#chatgpt-mermaid-\_r_1k3\_ .marker{fill:rgb(175, 175, 175);stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_1k3\_ .marker.cross{stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_1k3\_ svg{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;}#chatgpt-mermaid-\_r_1k3\_ p{margin:0;}#chatgpt-mermaid-\_r_1k3\_ defs [id$="-barbEnd"]{fill:rgb(175, 175, 175);stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_1k3\_ g.stateGroup text{fill:rgb(31, 78, 148);stroke:none;font-size:10px;}#chatgpt-mermaid-\_r_1k3\_ g.stateGroup text{fill:rgb(237, 237, 237);stroke:none;font-size:10px;}#chatgpt-mermaid-\_r_1k3\_ g.stateGroup .state-title{font-weight:bolder;fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_1k3\_ g.stateGroup rect{fill:rgb(9, 23, 44);stroke:rgb(31, 78, 148);}#chatgpt-mermaid-\_r_1k3\_ g.stateGroup line{stroke:rgb(175, 175, 175);stroke-width:1;}#chatgpt-mermaid-\_r_1k3\_ .transition{stroke:rgb(175, 175, 175);stroke-width:1;fill:none;}#chatgpt-mermaid-\_r_1k3\_ .stateGroup .composit{fill:transparent;border-bottom:1px;}#chatgpt-mermaid-\_r_1k3\_ .stateGroup .alt-composit{fill:#e0e0e0;border-bottom:1px;}#chatgpt-mermaid-\_r_1k3\_ .state-note{stroke:rgb(58, 132, 63);fill:rgb(48, 48, 48);}#chatgpt-mermaid-\_r_1k3\_ .state-note text{fill:rgb(237, 237, 237);stroke:none;font-size:10px;}#chatgpt-mermaid-\_r_1k3\_ .stateLabel .box{stroke:none;stroke-width:0;fill:rgb(9, 23, 44);opacity:0.5;}#chatgpt-mermaid-\_r_1k3\_ .edgeLabel .label rect{fill:rgb(9, 23, 44);opacity:0.5;}#chatgpt-mermaid-\_r_1k3\_ .edgeLabel{background-color:rgb(0, 0, 0);text-align:center;}#chatgpt-mermaid-\_r_1k3\_ .edgeLabel p{background-color:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_1k3\_ .edgeLabel rect{opacity:0.5;background-color:rgb(0, 0, 0);fill:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_1k3\_ .edgeLabel .label text{fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_1k3\_ .label div .edgeLabel{color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_1k3\_ .stateLabel text{fill:rgb(237, 237, 237);font-size:10px;font-weight:bold;}#chatgpt-mermaid-\_r_1k3\_ .node circle.state-start{fill:rgb(175, 175, 175);stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_1k3\_ .node .fork-join{fill:rgb(175, 175, 175);stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_1k3\_ .node circle.state-end{fill:rgb(31, 78, 148);stroke:transparent;stroke-width:1.5;}#chatgpt-mermaid-\_r_1k3\_ .end-state-inner{fill:transparent;stroke-width:1.5;}#chatgpt-mermaid-\_r_1k3\_ .node rect{fill:rgb(9, 23, 44);stroke:rgb(31, 78, 148);stroke-width:1px;}#chatgpt-mermaid-\_r_1k3\_ .node polygon{fill:rgb(9, 23, 44);stroke:rgb(31, 78, 148);stroke-width:1px;}#chatgpt-mermaid-\_r_1k3\_ [id$="-barbEnd"]{fill:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_1k3\_ .statediagram-cluster rect{fill:rgb(9, 23, 44);stroke:rgb(31, 78, 148);stroke-width:1px;}#chatgpt-mermaid-\_r_1k3\_ .cluster-label,#chatgpt-mermaid-\_r_1k3\_ .nodeLabel{color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_1k3\_ .statediagram-cluster rect.outer{rx:5px;ry:5px;}#chatgpt-mermaid-\_r_1k3\_ .statediagram-state .divider{stroke:rgb(31, 78, 148);}#chatgpt-mermaid-\_r_1k3\_ .statediagram-state .title-state{rx:5px;ry:5px;}#chatgpt-mermaid-\_r_1k3\_ .statediagram-cluster.statediagram-cluster .inner{fill:transparent;}#chatgpt-mermaid-\_r_1k3\_ .statediagram-cluster.statediagram-cluster-alt .inner{fill:rgb(48, 48, 48);}#chatgpt-mermaid-\_r_1k3\_ .statediagram-cluster .inner{rx:0;ry:0;}#chatgpt-mermaid-\_r_1k3\_ .statediagram-state rect.basic{rx:5px;ry:5px;}#chatgpt-mermaid-\_r_1k3\_ .statediagram-state rect.divider{stroke-dasharray:10,10;fill:rgb(48, 48, 48);}#chatgpt-mermaid-\_r_1k3\_ .note-edge{stroke-dasharray:5;}#chatgpt-mermaid-\_r_1k3\_ .statediagram-note rect{fill:rgb(48, 48, 48);stroke:rgb(58, 132, 63);stroke-width:1px;rx:0;ry:0;}#chatgpt-mermaid-\_r_1k3\_ .statediagram-note rect{fill:rgb(48, 48, 48);stroke:rgb(58, 132, 63);stroke-width:1px;rx:0;ry:0;}#chatgpt-mermaid-\_r_1k3\_ .statediagram-note text{fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_1k3\_ .statediagram-note .nodeLabel{color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_1k3\_ .statediagram .edgeLabel{color:red;}#chatgpt-mermaid-\_r_1k3\_ [id$="-dependencyStart"],#chatgpt-mermaid-\_r_1k3\_ [id$="-dependencyEnd"]{fill:rgb(175, 175, 175);stroke:rgb(175, 175, 175);stroke-width:1;}#chatgpt-mermaid-\_r_1k3\_ .statediagramTitleText{text-anchor:middle;font-size:18px;fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_1k3\_ [data-look="neo"].statediagram-cluster rect{fill:rgb(9, 23, 44);stroke:url(#chatgpt-mermaid-\_r_1k3\_-gradient);stroke-width:1;}#chatgpt-mermaid-\_r_1k3\_ [data-look="neo"].statediagram-cluster rect.outer{rx:5px;ry:5px;filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_1k3\_ .node .neo-node{stroke:rgb(31, 78, 148);}#chatgpt-mermaid-\_r_1k3\_ [data-look="neo"].node rect,#chatgpt-mermaid-\_r_1k3\_ [data-look="neo"].cluster rect,#chatgpt-mermaid-\_r_1k3\_ [data-look="neo"].node polygon{stroke:url(#chatgpt-mermaid-\_r_1k3\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_1k3\_ [data-look="neo"].swimlane.cluster rect{filter:none;}#chatgpt-mermaid-\_r_1k3\_ [data-look="neo"].node path{stroke:url(#chatgpt-mermaid-\_r_1k3\_-gradient);stroke-width:1px;}#chatgpt-mermaid-\_r_1k3\_ [data-look="neo"].node .outer-path{filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_1k3\_ [data-look="neo"].node .neo-line path{stroke:rgb(31, 78, 148);filter:none;}#chatgpt-mermaid-\_r_1k3\_ [data-look="neo"].node circle{stroke:url(#chatgpt-mermaid-\_r_1k3\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_1k3\_ [data-look="neo"].node circle .state-start{fill:#000000;}#chatgpt-mermaid-\_r_1k3\_ [data-look="neo"].icon-shape .icon{fill:url(#chatgpt-mermaid-\_r_1k3\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_1k3\_ [data-look="neo"].icon-shape .icon-neo path{stroke:url(#chatgpt-mermaid-\_r_1k3\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_1k3\_ :root{--mermaid-font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";}CreatedPreparingRunningFailedCompletedCancellingCancelledUnknown

`Unknown` is important. When telemetry disconnects, Converlt must not automatically claim that a training job failed.

## 15. API design

Start with a limited API surface.

| Method | Endpoint             | Purpose                  |
| ------ | -------------------- | ------------------------ |
| `POST` | `/projects`          | Create project           |
| `POST` | `/machines`          | Register machine         |
| `GET`  | `/machines`          | List authorized machines |
| `POST` | `/runs`              | Create run               |
| `POST` | `/runs/{id}/start`   | Launch run               |
| `GET`  | `/runs/{id}`         | Fetch run state          |
| `GET`  | `/runs/{id}/metrics` | Retrieve metrics         |
| `GET`  | `/runs/{id}/logs`    | Retrieve logs            |
| `POST` | `/runs/{id}/cancel`  | Request cancellation     |
| `POST` | `/runs/compare`      | Compare run metadata     |
| `POST` | `/ai/analyze-run`    | Analyze a run            |
| `POST` | `/compute/estimate`  | Estimate cost            |

For event streaming, use an authenticated WebSocket or server-sent event channel with sequence numbers and replay from the last acknowledged event.

### Runtime SDK interface

Keep the initial SDK extremely small:

```
import convergewith converge.run(    project="image-classifier",    config={"lr": 1e-4, "batch_size": 32},) as run:    for step, batch in enumerate(loader):        loss = train_step(batch)        run.log({            "train/loss": loss.item(),        }, step=step)
```

Existing training scripts should still run normally without Converlt installed. Advanced diagnostics may require explicit instrumentation, but core compute execution should not.

## 16. Security and reliability requirements

Converlt will execute user code on machines that may contain valuable models, private datasets, and cloud credentials. Security must be part of the MVP design.

| Area              | Requirement                                               |
| ----------------- | --------------------------------------------------------- |
| Machine access    | SSH keys or short-lived credentials; verify host identity |
| Secrets           | Never store plaintext provider keys in project files      |
| Agent permissions | Least privilege; no default root access                   |
| Network           | Outbound-only agent connection where feasible             |
| User code         | Execute under an isolated user or container context       |
| Data              | Local execution and opt-in upload by default              |
| Telemetry         | Redact known secrets and limit collected data             |
| Logs              | Retention controls and restricted access                  |
| Billing           | Server-side budgets and authorization                     |
| Reliability       | Reconnect, resumable streaming, idempotent job operations |
| Supply chain      | Signed agent binaries and dependency scanning             |

An additional principle: the Converlt agent and the AI assistant must have separate permissions. An AI tool call should never inherit unrestricted machine-level authority simply because the remote agent can execute processes.

# Part III — Delivery Roadmap

## 17. My recommended 18-month product roadmap

The original four-month MVP is achievable only if the scope stays small. I would target a reliable, paid-pilot-capable extension within 12–16 weeks and delay the standalone IDE.

## Release timeline

Proposed

Phase 0 — Discovery

Weeks 1–3

Customer interviews, workflow observation, technical spikes

Phase 1 — Private Alpha

Weeks 4–8

Extension, SSH runner, log streaming, GPU telemetry

Phase 2 — MVP Beta

Weeks 9–16

Run history, metrics, comparisons, failure diagnostics

Phase 3 — Commercial V1

Months 5–8

Provisioning, budgets, AI run analysis, paid teams

Phase 4 — Differentiation

Months 9–12

Tensor inspection, profiling, dataset integration, sweeps

Phase 5 — Platform

Months 13–18

Browser experience, stronger collaboration and enterprise options

The bars represent cumulative roadmap stages, not actual completion or measured engineering progress.

## Phase 0: Product discovery — Weeks 1–3

### Goals

Validate that remote training and experiment management are painful enough to justify a new tool.

Interview:

- 10 ML engineers at small AI startups.
- 8 independent fine-tuning developers.
- 7 academic researchers.
- 5 ML platform engineers.

Ask them to demonstrate their existing workflows, rather than simply requesting feature ideas.

Important questions:

1. What was your most recent failed training run?
2. How did you investigate the failure?
3. How much engineer time did it consume?
4. Where does your training run?
5. What tools do you use to compare experiments?
6. What happens when a remote training machine disconnects?
7. What do you pay for compute and ML development software?
8. Which tool would you stop using if Converlt worked?

### Exit criteria

- At least 10 interviewees report the same recurring workflow problem.
- At least 5 agree to participate in a real prototype test.
- At least 3 commercial teams express conditional willingness to pay.

These are validation targets, not guaranteed results.

## Phase 1: Private alpha — Weeks 4–8

Deliverable: A VS Code extension that launches and observes remote PyTorch training.

Build:

- Project initialization.
- Machine registration.
- SSH connection testing.
- Remote runner.
- Run status.
- Log streaming.
- GPU telemetry.
- Basic run history.
- Reconnection handling.

### Definition of done

A user can take an existing PyTorch repository, connect an SSH GPU machine, run training, close the editor, reopen it, and recover the run's status and logs.

Test on at least two Linux GPU environments and multiple CUDA/PyTorch configurations.

## Phase 2: MVP beta — Weeks 9–16

Build:

- Structured experiment manifest.
- Metric ingestion.
- Training curves.
- Run comparison.
- Config and Git diff view.
- Failure classification.
- OOM report.
- Basic NaN instrumentation.
- Local-first metadata caching.
- Optional cloud sync.

### Definition of done

A pilot user can compare two runs and explain what changed without reconstructing the experiment manually.

This is the point where I would begin testing paid pilots.

## Phase 3: Commercial V1 — Months 5–8

Build:

- One provider provisioning integration.
- Compute cost estimates.
- Budget controls.
- Idle shutdown.
- AI-assisted run analysis.
- Organization projects.
- Basic access controls.
- Subscription billing.
- Documentation and onboarding.

### Exit criteria

- At least 10 active commercial teams.
- Five paying organizations.
- Repeat weekly usage among engineers who train models.
- Demonstrated reduction in setup, debugging, or comparison time.

## Phase 4: ML-native differentiation — Months 9–12

Choose based on evidence, not feature popularity.

Potential features:

- Runtime tensor shape inspection.
- Gradient-flow diagnostics.
- PyTorch profiler integration.
- Dataset sample inspection.
- Experiment-aware AI code suggestions.
- Budgeted hyperparameter search.
- Model graph exploration.

I would choose two or three, not all seven simultaneously.

## Phase 5: Platform expansion — Months 13–18

Only if retention is strong:

- Custom Converlt IDE distribution.
- Browser-based development.
- Team collaboration.
- Enterprise authentication.
- More providers.
- Deployment integrations.
- Stronger observability and support tooling.

# Part IV — Business Model and Product Metrics

## 18. Pricing strategy

I recommend keeping the editor and local run inspection accessible while monetizing advanced workflow capabilities and collaboration.

| Plan       | Proposed price | Features                                                      |
| ---------- | -------------- | ------------------------------------------------------------- |
| Community  | Free           | Local projects, SSH connections, basic run history            |
| Pro        | $24/month      | Advanced diagnostics, AI analysis allowance, larger histories |
| Team       | $39/user/month | Shared projects, run comparison, team permissions             |
| Enterprise | Custom         | SSO, private hosting, audit controls, support                 |

These are pricing hypotheses requiring willingness-to-pay testing.

### GPU monetization

I would introduce managed GPU resale only after Converlt has demonstrated strong usage.

Why?

- GPU margins vary by provider and capacity.
- Provisioning failures create support burdens.
- Idle capacity can become a financial liability.
- Billing disputes could damage the core developer-tool brand.

Initially, let customers bring their own provider accounts. Converlt can monetize developer productivity without taking infrastructure risk.

## 19. Success metrics

## North-star metric

Weekly active engineers completing meaningful ML runs through Converlt

# Completed ML runs / active engineer

Track alongside reliability and user outcomes. Do not optimize raw run counts alone, since unnecessary runs can waste compute.

### Product metrics

| Metric                           | What it tells you                        |
| -------------------------------- | ---------------------------------------- |
| Installation → first run         | Onboarding effectiveness                 |
| Time to first remote run         | Compute workflow friction                |
| Weekly active engineers          | Repeat usage                             |
| Runs captured per user           | Adoption depth                           |
| Run comparison usage             | Experiment-module value                  |
| Failure diagnosis usage          | Debugging-module value                   |
| Time to resolve training failure | Actual user benefit                      |
| GPU cost avoided                 | Economic value where measurable          |
| Team expansion                   | Commercial adoption                      |
| 4-week retention                 | Whether the product is becoming habitual |

### Suggested beta targets

- Median time to first successful connected GPU run: under 10 minutes for an existing ready-to-use machine.
- At least 80% of pilot users successfully complete the onboarding flow without developer assistance.
- At least 60% of activated pilot users return in a subsequent week.
- At least 30% of retained users try run comparison.
- Fewer than 1% of attempted run starts fail because of Converlt-controlled orchestration errors.

These are design goals. Baselines should be established during the alpha.

# Part V — Engineering Execution and Product Decisions

## 20. Team required

For a credible private beta, I would aim for a small team with the following responsibilities.

| Role                         | Responsibility                                    |
| ---------------------------- | ------------------------------------------------- |
| Product/technical founder    | Product vision, customer interviews, architecture |
| TypeScript engineer          | Extension and developer interface                 |
| Backend/infra engineer       | Remote runner, APIs, cloud integration            |
| ML systems engineer          | PyTorch SDK, diagnostics, profiling               |
| Product designer (part-time) | Workflow design and usability                     |

If you are building this alone, you should narrow the first version to:

1. VS Code extension.
2. SSH remote training.
3. GPU telemetry.
4. Automatic run history.
5. Basic run comparison.

That is already a meaningful engineering project.

## 21. Build-versus-buy decisions

| Capability                   | Recommendation                        | Reason                                     |
| ---------------------------- | ------------------------------------- | ------------------------------------------ |
| Code editing                 | Extend VS Code                        | Avoid rebuilding editor infrastructure     |
| Python language intelligence | Existing Python tooling               | Mature ecosystem                           |
| SSH connectivity             | Existing libraries                    | Standardized functionality                 |
| Remote runner                | Build                                 | Core reliability and control               |
| GPU telemetry                | Existing NVIDIA tools + custom agent  | Avoid reinventing hardware instrumentation |
| Experiment metadata          | Build                                 | Central Converlt data model                |
| PyTorch profiling            | Integrate                             | PyTorch already exposes instrumentation    |
| Cloud provisioning           | Provider SDK first; evaluate SkyPilot | Reduce provider-specific work              |
| AI model                     | Use model APIs initially              | Avoid training your own assistant          |
| Authentication               | Managed auth                          | Reduce security complexity                 |
| Billing                      | Established billing provider          | Avoid custom payment infrastructure        |

SkyPilot has documented interfaces for launching and managing cloud workloads, making it a reasonable candidate for later multi-cloud support. Evaluate its current provider compatibility and operational behavior before committing.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://docs.skypilot.co\&sz=32)

SkyPilot documentation

[image](https://www.google.com/s2/favicons?domain=https://docs.skypilot.co\&sz=32)

SkyPilot documentation



## 22. Major product risks

Critical

Developers don't want to switch editors.

Mitigation: Start with an extension. Measure actual adoption before considering a Code-OSS fork.

Critical

Remote training isn't reliable enough.

Mitigation: Prioritize job persistence, reconnects, recovery, and clear process states over UI polish.

High

“Automatic” tracking cannot capture arbitrary metrics.

Mitigation: Distinguish universally observable run metadata from framework-specific and opt-in instrumentation.

High

Debugging overhead slows training.

Mitigation: Use lightweight monitoring by default and selective, sampled deep diagnostics.

High

Existing platforms replicate valuable features.

Mitigation: Build around cross-tool context and superior training workflows rather than isolated feature checkboxes.

## 23. First four engineering sprints

## Implementation checklist

0/16 tasks

Sprint 1 — Foundations

Create extension and remote-agent skeleton

Define run manifest and API contracts

Build project and machine registration

Implement SSH connection test

Sprint 2 — Remote execution

Implement persistent training process supervisor

Stream and replay stdout/stderr

Implement run status state machine

Add cancellation and reconnection

Sprint 3 — GPU visibility

Collect GPU and host telemetry

Add live status bar and compute panel

Handle unavailable or unsupported GPUs

Persist telemetry summaries

Sprint 4 — Experiment history

Record Git/config/environment fingerprints

Implement initial Python metric SDK

Build run list and detail screens

Add two-run metric and config comparison

&#x20;Copy sprint checklist

## 24. The decisions I would make now

## Recommended product configuration

My choice

Editor foundation

VS Code extension first

Code-OSS fork immediately

Initial compute integration

Existing SSH GPU machines

Direct cloud GPU provisioning

Initial ML framework

PyTorch only

PyTorch + JAX + TensorFlow

Experiment backend

Native Converlt runs and metrics

Integrate existing tracking tools first

Turn selections into implementation specification&#x20;

## My final recommendation

Converlt has a strong conceptual vision, but I would resist trying to build all six modules into the first release.

The winning initial product is:

Converlt = VS Code + reliable remote GPU training + experiment-aware debugging.

Specifically, a developer should be able to:

- Open a PyTorch project.
- Connect their GPU.
- Launch training.
- See what's happening.
- Understand why it failed.
- Compare the result with their previous attempt.
- Reproduce a successful run.

Make that experience exceptionally reliable before moving into autonomous sweeps, tensor-aware coding, deployment, and managed compute.

The first real milestone isn't a beautiful standalone IDE. It's getting five ML engineers to say, “I don't want to run my next training experiment without Converlt.”