// An icon for each Model Builder layer, colored by its family, in the same black square as the
// dashboard's icon tiles. Used in the palette and on canvas nodes.
import type { ComponentType } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  AudioWaveform,
  Box,
  ChevronsDownUp,
  CircleDashed,

  Expand,
  Eye,
  FileCode,
  Grid3x3,
  Hash,
  Layers,
  MapPin,
  Maximize2,
  Merge,
  Minimize,
  Minimize2,
  Network,
  Percent,
  Plus,
  Repeat,
  Scan,
  Shapes,
  Shrink,
  Sigma,
  SlidersHorizontal,
  SlidersVertical,
  Spline,
  Timer,
  TrendingUp,

} from "lucide-react";
import { LAYER, type LayerSpec, type LayerType } from "@converge/run-protocol";

type Icon = ComponentType<{ size?: number; strokeWidth?: number }>;

const ICONS: Record<LayerType, Icon> = {
  Input: ArrowDownToLine,
  Output: ArrowUpFromLine,
  Timestep: Timer,
  Linear: Network,
  Dropout: CircleDashed,
  Flatten: ChevronsDownUp,
  Conv1d: AudioWaveform,
  Conv2d: Grid3x3,
  Conv3d: Box,
  ConvTranspose2d: Expand,
  Upsample: Maximize2,
  MaxPool1d: Shrink,
  MaxPool2d: Shrink,
  MaxPool3d: Shrink,
  AvgPool2d: Minimize2,
  AdaptiveAvgPool1d: Minimize,
  AdaptiveAvgPool2d: Minimize,
  AdaptiveAvgPool3d: Minimize,
  BatchNorm: SlidersHorizontal,
  LayerNorm: SlidersVertical,
  ReLU: TrendingUp,
  LeakyReLU: TrendingUp,
  GELU: Spline,
  SiLU: Spline,
  Tanh: Activity,
  Sigmoid: Activity,
  Softmax: Percent,
  Embedding: Hash,
  LSTM: Repeat,
  GRU: Repeat,
  MultiheadAttention: Eye,
  TransformerEncoderLayer: Layers,
  PositionEmbedding: MapPin,
  SequencePool: Sigma,
  Reshape: Shapes,
  Permute: ArrowLeftRight,
  Add: Plus,
  Concat: Merge,
  Custom: FileCode,
};

/** Icon color per family (the square behind it is the same for all). */
const FAMILY: Record<LayerSpec["group"], string> = {
  "Input / output": "var(--info)",
  Dense: "var(--s3)",
  Convolution: "var(--ok)",
  Pooling: "var(--s6)",
  Normalization: "var(--text-2)",
  Activation: "var(--s4)",
  Sequence: "var(--accent-text)",
  Shape: "var(--s2)",
  Combine: "var(--warn)",
};

export function LayerIcon({ type, size = 14 }: { type: LayerType; size?: number }) {
  const I = ICONS[type] ?? Scan;
  const tint = type === "Custom" ? "var(--text-2)" : FAMILY[LAYER[type]?.group ?? "Combine"];
  return (
    <span className="layer-icon" style={{ "--tint": tint, width: size + 12, height: size + 12 } as React.CSSProperties} aria-hidden>
      <I size={size} strokeWidth={2} />
    </span>
  );
}

