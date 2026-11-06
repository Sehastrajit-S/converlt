import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { FolderOpen, LoaderCircle } from "lucide-react";
import type { Machine } from "@converge/run-protocol";
import {
  api,
  Compare,
  Compute,
  Data,
  Empty,
  Environments,
  Gpus,
  Home,
  Hub,
  ModelBuilder,
  Models,
  PhoneAlerts,
  ThemeGallery,
  Wallet,
  errorMessage,
  MachineDialog,
  NewRunDialog,
  RunDetail,
  Runs,
  setApi,
  ToastProvider,
  useAppState,
  useRuns,
  useToast,
  type NewRunPrefill,
} from "@converge/ui";
import "@converge/ui/styles.css";
import "./theme.css";
import { hostCommand, onNavigate, rpcApi } from "./rpc.ts";
import type { Route } from "./protocol.ts";

setApi(rpcApi);

function App({ initial }: { initial: Route }) {
  const [state] = useAppState();
  const runs = useRuns(state?.project?.path);
  const [route, setRoute] = useState<Route>(initial);
  const [newRun, setNewRun] = useState<NewRunPrefill | null>(null);
  const [machineDialog, setMachineDialog] = useState<{ machine?: Machine } | null>(null);
  const toast = useToast();

  useEffect(() => onNavigate(setRoute), []);

  const reproduce = useCallback(
    async (runId: string) => {
      try {
        const plan = await api.planReproduce(runId);
        const name = runs.find((r) => r.runId === runId)?.name;
        setNewRun({ command: plan.command, machineId: plan.machineId, options: plan.options, warnings: plan.warnings, reproducedFrom: runId, reproducedName: name });
      } catch (e) {
        toast("error", "Cannot reproduce", errorMessage(e));
      }
    },
    [runs, toast],
  );

  if (!state)
    return (
      <div className="empty">
        <LoaderCircle className="spin" />
      </div>
    );

  let body;
  if (route.view === "compute") {
    body = <Compute state={state} onAdd={() => setMachineDialog({})} onEdit={(m) => setMachineDialog({ machine: m })} />;
  } else if (route.view === "dashboard") {
    body = (
      <Home
        state={state}
        runs={runs}
        dashboard
        onShowCode={() => hostCommand({ name: "showCode" })}
        onOpenProject={(path) => hostCommand({ name: "openProject", path })}
        onOpenFolder={() => api.openProjectDialog()}
        onNewRun={() => hostCommand({ name: "newRun" })}
        onOpenRun={(runId) => hostCommand({ name: "openRun", runId })}
        onOpenRuns={() => hostCommand({ name: "openRuns" })}
        onOpenGpus={() => hostCommand({ name: "openGpus" })}
        onOpenWallet={() => hostCommand({ name: "openWallet" })}
        onOpenModels={() => hostCommand({ name: "openModels" })}
        onOpenEnvironments={() => hostCommand({ name: "openEnvironments" })}
        onOpenHub={() => hostCommand({ name: "openHub" })}
        onOpenData={() => hostCommand({ name: "openData" })}
        onOpenBuilder={() => hostCommand({ name: "openBuilder" })}
        onAddMachine={() => setMachineDialog({})}
      />
    );
  } else if (route.view === "wallet") {
    body = <Wallet onOpenGpus={() => hostCommand({ name: "openGpus" })} onOpenModels={() => hostCommand({ name: "openModels" })} />;
  } else if (route.view === "gpus") {
    body = (
      <Gpus
        state={state}
        preselect={route.preselect}
        onRun={(machineId) => (state.project ? setNewRun({ machineId }) : hostCommand({ name: "newRun", machineId }))}
        onEnvironments={(machineId) => hostCommand({ name: "openEnvironments", machineId })}
      />
    );
  } else if (route.view === "data") {
    body = <Data state={state} onOpenRun={(runId) => hostCommand({ name: "openRun", runId })} />;
  } else if (route.view === "builder") {
    body = <ModelBuilder state={state} importFile={route.importFile ?? null} onTrain={(command, machineId) => setNewRun({ command, machineId })} onOpenData={() => hostCommand({ name: "openData" })} />;
  } else if (route.view === "themes") {
    body = (
      <div className="page">
        <div className="page-header">
          <div>
            <h1 className="page-title">Themes</h1>
            <div className="page-sub">One choice styles everything: the editor, sidebars and every Converlt page.</div>
          </div>
        </div>
        <ThemeGallery fallback={state.settings.theme} />
      </div>
    );
  } else if (route.view === "alerts") {
    body = <PhoneAlerts state={state} />;
  } else if (route.view === "models") {
    body = <Models />;
  } else if (route.view === "envs") {
    body = <Environments state={state} initialMachineId={route.machineId} />;
  } else if (route.view === "hub") {
    body = <Hub state={state} initialMachineId={route.machineId} />;
  } else if (!state.project) {
    body = (
      <div className="page">
        <div className="card">
          <Empty icon={<FolderOpen size={24} />} title="Open a folder to start" action={<button className="btn primary" onClick={() => api.openProjectDialog()}>Open Folder</button>}>
            Converlt works on the folder open in the editor: it syncs that code to a GPU machine and keeps the run history in .converge/.
          </Empty>
        </div>
      </div>
    );
  } else if (route.view === "run") {
    body = <RunDetail
        key={route.runId}
        runId={route.runId}
        onBack={() => hostCommand({ name: "openRuns" })}
        onReproduce={reproduce}
        onRent={({ offer, thenRun }) => hostCommand({ name: "openGpus", preselect: { offerId: offer.id, cloud: offer.cloud, thenRun } })}
      />;
  } else if (route.view === "compare") {
    body = <Compare runs={runs} ids={route.runIds} onChange={(ids) => setRoute({ view: "compare", runIds: ids })} onOpen={(runId) => hostCommand({ name: "openRun", runId })} />;
  } else {
    body = (
      <Runs
        state={state}
        runs={runs}
        embedded
        onOpen={(runId) => hostCommand({ name: "openRun", runId })}
        onNewRun={() => setNewRun({})}
        onCompare={(ids) => hostCommand({ name: "openCompare", runIds: ids })}
      />
    );
  }

  return (
    <>
      {body}
      {newRun && state.project && (
        <NewRunDialog
          state={state}
          prefill={newRun}
          onClose={() => setNewRun(null)}
          onSetupAlerts={() => hostCommand({ name: "openAlerts" })}
          onLaunched={(runId) => {
            setNewRun(null);
            hostCommand({ name: "openRun", runId });
          }}
        />
      )}
      {machineDialog && <MachineDialog machine={machineDialog.machine} onClose={() => setMachineDialog(null)} />}
    </>
  );
}

const initial = JSON.parse(document.getElementById("converge-route")!.textContent!) as Route;
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <App initial={initial} />
    </ToastProvider>
  </StrictMode>,
);
