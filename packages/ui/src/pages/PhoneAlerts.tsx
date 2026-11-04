import { useMemo, useState } from "react";
import { BellRing, LoaderCircle, RefreshCw, Send, Smartphone } from "lucide-react";
import qrcode from "qrcode-generator";
import type { AppState } from "@converge/core/api";
import { api, errorMessage } from "../api.ts";
import { useToast } from "../components/ui.tsx";

const NTFY = "https://ntfy.sh";

/** A topic nobody can guess: the topic name is the only thing that protects an ntfy channel. */
function newTopicUrl(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `${NTFY}/converlt-${[...bytes].map((b) => alphabet[b % alphabet.length]).join("")}`;
}

function Qr({ text, size = 180 }: { text: string; size?: number }) {
  const { n, d } = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    const count = q.getModuleCount();
    let path = "";
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (q.isDark(r, c)) path += `M${c} ${r}h1v1h-1z`;
    return { n: count, d: path };
  }, [text]);
  // Always dark on white, whatever the theme: phone cameras need the contrast.
  return (
    <svg viewBox={`-3 -3 ${n + 6} ${n + 6}`} width={size} height={size} shapeRendering="crispEdges" style={{ background: "#fff", borderRadius: 10, flex: "none" }} role="img" aria-label="QR code for the alert topic">
      <path d={d} fill="#000" />
    </svg>
  );
}

/** Phone alerts through ntfy: the GPU machine posts when a run ends or needs attention, even with the editor closed. */
export function PhoneAlerts({ state }: { state: AppState }) {
  const toast = useToast();
  const opts = state.settings.defaultOptions;
  const url = opts.notifyUrl ?? "";
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [custom, setCustom] = useState("");

  const save = async (notifyUrl: string | undefined) => {
    setBusy("save");
    try {
      await api.updateSettings({ defaultOptions: { ...opts, notifyUrl } });
    } catch (e) {
      toast("error", "Couldn't save", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const test = async () => {
    setBusy("test");
    try {
      await api.testPhoneAlert(url);
      toast("success", "Test sent", "It should be on your phone within a few seconds.");
    } catch (e) {
      toast("error", "Couldn't send the test", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const topic = url.split("/").pop() ?? "";

  return (
    <div className="page" style={{ maxWidth: 860 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Phone alerts</h1>
          <div className="page-sub">
            Get a message on your phone when a run finishes, fails, hits a NaN loss or stalls. The GPU machine sends it, so it arrives even when this computer is
            asleep.
          </div>
        </div>
      </div>

      {!url ? (
        <div className="card">
          <div className="card-body col" style={{ gap: 12, alignItems: "flex-start" }}>
            <div className="row" style={{ gap: 10 }}>
              <Smartphone size={20} />
              <b>Alerts use ntfy, a free, open-source notification app for Android and iPhone. No account needed.</b>
            </div>
            <button className="btn primary" disabled={!!busy} onClick={() => void save(newTopicUrl())}>
              {busy ? <LoaderCircle size={14} className="spin" /> : <BellRing size={14} />} Turn on phone alerts
            </button>
            <details>
              <summary className="faint" style={{ cursor: "pointer" }}>
                Use your own ntfy server
              </summary>
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <input className="input mono" style={{ width: 360 }} placeholder="https://ntfy.example.com/my-topic" value={custom} onChange={(e) => setCustom(e.target.value)} />
                <button className="btn" disabled={!/^https?:\/\/.+\/[A-Za-z0-9_-]{1,64}$/.test(custom.trim())} onClick={() => void save(custom.trim())}>
                  Use it
                </button>
              </div>
            </details>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="card-body row wrap" style={{ gap: 24, alignItems: "flex-start" }}>
            <Qr text={url} />
            <div className="col" style={{ gap: 10, flex: 1, minWidth: 280 }}>
              <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
                <li>
                  Install <b>ntfy</b> from the{" "}
                  <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy">Play Store</a> or the <a href="https://apps.apple.com/app/ntfy/id1625396347">App Store</a>.
                </li>
                <li>Scan this code with the phone's camera, or in ntfy tap + and subscribe to the topic below.</li>
                <li>Send a test.</li>
              </ol>
              <div className="mono selectable" style={{ fontSize: 13, padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6 }}>
                {topic}
              </div>
              <div className="row wrap" style={{ gap: 8 }}>
                <button className="btn primary" disabled={!!busy} onClick={() => void test()}>
                  {busy === "test" ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />} Send a test
                </button>
                <button className="btn" disabled={!!busy} onClick={() => confirm("Make a new topic? Phones subscribed to the old one stop getting alerts.") && void save(newTopicUrl())}>
                  <RefreshCw size={14} /> New topic
                </button>
                <button className="btn ghost" disabled={!!busy} onClick={() => void save(undefined)}>
                  Turn off
                </button>
              </div>
              <div className="faint" style={{ fontSize: 12 }}>
                New runs alert this topic; you can turn it off for a single run in its launch options. Alerts carry the run name, its status and the error,
                never code or data. Anyone who knows the topic name can read them, so keep it to yourself.
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
