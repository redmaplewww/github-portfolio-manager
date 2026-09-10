"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Code2,
  FileCode2,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  LoaderCircle,
  RefreshCw,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  X,
  XCircle,
} from "lucide-react";
import type {
  AiMergeReview,
  MergeGateEvaluation,
  PullRequestBundle,
  PullRequestFile,
  PullRequestListItem,
  RepositoryMergePolicy,
  SourceComparison,
} from "@/src/modules/github-portfolio/contracts";
import styles from "./github-pr-review-workbench.module.css";

type DetailResponse = {
  bundle: PullRequestBundle;
  policy: RepositoryMergePolicy;
  review: AiMergeReview | null;
  evaluation: MergeGateEvaluation;
};

type MergePlan = {
  allowed: boolean;
  evaluation: MergeGateEvaluation;
  token: string | null;
  expiresAt: string | null;
  method?: string;
  headSha?: string;
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(payload.error || "请求失败");
  return payload.data as T;
}

function query(item: Pick<PullRequestListItem, "repository" | "number">) {
  return `repository=${encodeURIComponent(item.repository)}&number=${item.number}`;
}

const date = (value: string) => new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
const verdictLabel = (verdict: AiMergeReview["verdict"]) => verdict === "merge" ? "未见代码阻断" : verdict === "needs_changes" ? "发现代码风险" : verdict === "manual_review" ? "需要补充局部证据" : "当前证据不足";

export function GithubPullRequestWorkbench() {
  const [queue, setQueue] = useState<PullRequestListItem[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [tab, setTab] = useState<"diff" | "source" | "checks">("diff");
  const [activeFile, setActiveFile] = useState("");
  const [sources, setSources] = useState<SourceComparison[]>([]);
  const [activeSource, setActiveSource] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [busy, setBusy] = useState<"review" | "plan" | "merge" | "policy" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [plan, setPlan] = useState<MergePlan | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [showPolicy, setShowPolicy] = useState(false);
  const [draftPolicy, setDraftPolicy] = useState<RepositoryMergePolicy | null>(null);

  const selected = useMemo(() => queue.find((item) => `${item.repository}#${item.number}` === selectedKey) || null, [queue, selectedKey]);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await api<PullRequestListItem[]>("/api/v1/github-portfolio/pull-requests?action=list");
      setQueue(rows);
      setSelectedKey((current) => current && rows.some((item) => `${item.repository}#${item.number}` === current) ? current : rows[0] ? `${rows[0].repository}#${rows[0].number}` : "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "PR 队列读取失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (item: PullRequestListItem) => {
    setDetailLoading(true);
    setError(null);
    setPlan(null);
    setSources([]);
    try {
      const next = await api<DetailResponse>(`/api/v1/github-portfolio/pull-requests?action=detail&${query(item)}`);
      setDetail(next);
      setActiveFile(next.bundle.files[0]?.path || "");
      setDraftPolicy(next.policy);
    } catch (cause) {
      setDetail(null);
      setError(cause instanceof Error ? cause.message : "PR 详情读取失败");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadQueue(); }, [loadQueue]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (selected) void loadDetail(selected); }, [selected, loadDetail]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(null), 4500); return () => window.clearTimeout(timer); }, [notice]);

  const loadSources = async () => {
    if (!selected || sources.length) return;
    setSourceLoading(true);
    setError(null);
    try {
      const rows = await api<SourceComparison[]>(`/api/v1/github-portfolio/pull-requests?action=sources&${query(selected)}`);
      setSources(rows);
      setActiveSource(rows[0]?.path || "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "源码上下文读取失败");
    } finally {
      setSourceLoading(false);
    }
  };

  const changeTab = (next: "diff" | "source" | "checks") => {
    setTab(next);
    if (next === "source") void loadSources();
  };

  const runReview = async () => {
    if (!selected) return;
    setBusy("review");
    setError(null);
    setPlan(null);
    try {
      await api(`/api/v1/github-portfolio/pull-requests`, {
        method: "POST",
        body: JSON.stringify({ action: "ai-review", repository: selected.repository, number: selected.number }),
      });
      await loadDetail(selected);
      setNotice("AI 审查完成，结论已绑定当前 head SHA");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "AI 审查失败");
    } finally {
      setBusy(null);
    }
  };

  const createPlan = async () => {
    if (!selected) return;
    setBusy("plan");
    setError(null);
    try {
      const next = await api<MergePlan>("/api/v1/github-portfolio/pull-requests", {
        method: "POST",
        body: JSON.stringify({ action: "plan-merge", repository: selected.repository, number: selected.number }),
      });
      setPlan(next);
      if (!next.allowed) setNotice("门禁未全部通过，已显示阻塞项");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "合并计划生成失败");
    } finally {
      setBusy(null);
    }
  };

  const applyMerge = async () => {
    if (!selected || !plan?.token) return;
    setBusy("merge");
    setError(null);
    try {
      await api("/api/v1/github-portfolio/pull-requests", {
        method: "POST",
        body: JSON.stringify({ action: "apply-merge", repository: selected.repository, number: selected.number, confirmationToken: plan.token }),
      });
      setPlan(null);
      setConfirmText("");
      setNotice(`PR #${selected.number} 已由 GitHub 确认合并`);
      await loadQueue();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "合并失败");
    } finally {
      setBusy(null);
    }
  };

  const savePolicy = async () => {
    if (!selected || !draftPolicy) return;
    setBusy("policy");
    setError(null);
    try {
      await api("/api/v1/github-portfolio/pull-requests", {
        method: "POST",
        body: JSON.stringify({ action: "save-policy", repository: selected.repository, number: selected.number, policy: draftPolicy }),
      });
      setShowPolicy(false);
      setNotice("仓库合并策略已保存");
      await loadDetail(selected);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "策略保存失败");
    } finally {
      setBusy(null);
    }
  };

  const activePatch = detail?.bundle.files.find((file) => file.path === activeFile) || detail?.bundle.files[0];
  const source = sources.find((item) => item.path === activeSource) || sources[0];
  const evaluation = plan?.evaluation || detail?.evaluation;
  const mergePhrase = selected ? `MERGE #${selected.number}` : "";

  return <main className={styles.shell}>
    <header className={styles.topbar}>
      <div className={styles.brand}><span><GitMerge size={17} /></span><div><b>PR 审查台</b><small>AI MERGE CONTROL</small></div></div>
      <div className={styles.topActions}><Link href="/github"><ArrowLeft size={14} />代码版图</Link><button onClick={() => void loadQueue()} aria-label="刷新 PR 队列"><RefreshCw size={15} className={loading ? styles.spin : ""} /></button></div>
    </header>
    <section className={styles.commandBar}>
      <div><span className={styles.liveDot} />只读证据链已连接</div>
      <p>AI 负责审查建议，合并由 CI、评审、规模、敏感路径和一次性确认共同决定。</p>
      <button disabled={!detail} onClick={() => setShowPolicy(true)}><Settings2 size={14} />仓库策略</button>
    </section>
    {error ? <div className={styles.errorBar}><CircleAlert size={16} /><span>{error}</span><button onClick={() => setError(null)}><X size={14} /></button></div> : null}
    <div className={styles.workspace}>
      <aside className={styles.queueRail}>
        <header><div><span>OPEN PULL REQUESTS</span><h1>审查队列</h1></div><b>{queue.length}</b></header>
        {loading ? <Loading label="正在读取追踪仓库" /> : queue.length ? <div className={styles.queueList}>{queue.map((item) => {
          const key = `${item.repository}#${item.number}`;
          const checksPass = item.checks.length > 0 && item.checks.every((check) => check.passing);
          return <button key={key} className={selectedKey === key ? styles.selectedPr : ""} onClick={() => setSelectedKey(key)}>
            <div className={styles.prRowTop}><span><GitPullRequest size={13} />#{item.number}</span><em>{date(item.updatedAt)}</em></div>
            <strong>{item.title}</strong>
            <small>{item.repository}</small>
            <div className={styles.prSignals}><span className={checksPass ? styles.pass : styles.block}>{checksPass ? <Check size={11} /> : <CircleAlert size={11} />}{item.checks.length ? `${item.checks.filter((check) => check.passing).length}/${item.checks.length} CI` : "无 CI"}</span><span>+{item.additions} / -{item.deletions}</span><span>{item.changedFiles} files</span></div>
          </button>;
        })}</div> : <div className={styles.emptyQueue}><GitPullRequest size={24} /><b>追踪范围内没有开放 PR</b><p>回到代码版图选择仓库；新 PR 出现后会自动进入这里。</p></div>}
      </aside>

      <section className={styles.reviewPane}>
        {detailLoading ? <Loading label="正在装载 Diff 与合并事实" /> : detail ? <>
          <header className={styles.prHeader}>
            <div className={styles.prIdentity}><span>{detail.bundle.repository} / PR #{detail.bundle.number}</span><h2>{detail.bundle.title}</h2><p><b>{detail.bundle.author}</b> 将 <code>{detail.bundle.headRefName}</code> 合入 <code>{detail.bundle.baseRefName}</code> · <code>{detail.bundle.headRefOid.slice(0, 8)}</code></p></div>
            <div className={styles.changeStats}><span className={styles.add}>+{detail.bundle.additions}</span><span className={styles.del}>−{detail.bundle.deletions}</span><span>{detail.bundle.changedFiles} files</span></div>
          </header>
          <nav className={styles.tabs} aria-label="PR 证据视图">
            <button className={tab === "diff" ? styles.activeTab : ""} onClick={() => changeTab("diff")}><GitCommitHorizontal size={14} />Diff</button>
            <button className={tab === "source" ? styles.activeTab : ""} onClick={() => changeTab("source")}><Code2 size={14} />源码比对</button>
            <button className={tab === "checks" ? styles.activeTab : ""} onClick={() => changeTab("checks")}><ShieldCheck size={14} />Checks & Reviews</button>
          </nav>
          {tab === "diff" ? <DiffView files={detail.bundle.files} active={activePatch} onSelect={setActiveFile} /> : tab === "source" ? <SourceView rows={sources} active={source} loading={sourceLoading} onSelect={setActiveSource} /> : <ChecksView detail={detail} />}
        </> : <div className={styles.emptyDetail}><Code2 size={28} /><h2>选择一个 PR 开始审查</h2><p>Diff、源码上下文、检查结果和 AI 结论都会留在这个控制台里。</p></div>}
      </section>

      <aside className={styles.aiRail}>
        <header className={styles.aiHeader}><span><Sparkles size={15} />AI REVIEW</span><em>{detail?.review?.model || "等待运行"}</em></header>
        {detail ? <>
          <Verdict review={detail.review} />
          <button className={styles.reviewButton} disabled={busy !== null} onClick={() => void runReview()}>{busy === "review" ? <LoaderCircle className={styles.spin} size={15} /> : <Bot size={15} />}{detail.review ? "重新运行 AI 审查" : "运行 AI 审查"}</button>
          <section className={styles.gates}>
            <header><b>确定性合并门禁</b><span>{evaluation?.gates.filter((gate) => gate.passed).length || 0}/{evaluation?.gates.length || 0}</span></header>
            {evaluation?.gates.map((gate) => <div key={gate.id} className={gate.passed ? styles.gatePass : styles.gateBlock}>{gate.passed ? <CheckCircle2 size={14} /> : <XCircle size={14} />}<span><b>{gate.label}</b><small>{gate.detail}</small></span></div>)}
          </section>
          <div className={styles.mergeActions}>
            <button disabled={busy !== null || !detail.review} onClick={() => void createPlan()}>{busy === "plan" ? <LoaderCircle className={styles.spin} size={15} /> : <ShieldCheck size={15} />}生成合并计划</button>
            <small>不会直接合并；计划通过后仍需你输入确认短语。</small>
          </div>
        </> : <div className={styles.aiEmpty}><ShieldAlert size={23} /><b>AI 不拥有最终决定权</b><p>先选择 PR。审查 Agent 会读取受限 Diff 与源码上下文，但不能修改仓库或绕过门禁。</p></div>}
      </aside>
    </div>

    {showPolicy && draftPolicy && selected ? <PolicyDialog policy={draftPolicy} repository={selected.repository} busy={busy === "policy"} onChange={setDraftPolicy} onClose={() => setShowPolicy(false)} onSave={() => void savePolicy()} /> : null}
    {plan?.allowed && plan.token && selected ? <div className={styles.modalBackdrop} role="presentation"><section className={styles.confirmModal} role="dialog" aria-modal="true" aria-labelledby="confirm-title"><span className={styles.warningIcon}><ShieldAlert size={22} /></span><h2 id="confirm-title">确认合并 PR #{selected.number}</h2><p>即将以 <b>{plan.method}</b> 方式合并 <code>{plan.headSha?.slice(0, 8)}</code>。执行前服务端会再次读取 GitHub 并校验全部门禁。</p><label>输入 <code>{mergePhrase}</code> 继续<input autoFocus value={confirmText} onChange={(event) => setConfirmText(event.target.value)} /></label><div><button className={styles.cancelButton} onClick={() => { setPlan(null); setConfirmText(""); }}>取消</button><button className={styles.dangerButton} disabled={confirmText !== mergePhrase || busy === "merge"} onClick={() => void applyMerge()}>{busy === "merge" ? <LoaderCircle className={styles.spin} size={15} /> : <GitMerge size={15} />}确认并合并</button></div><small>令牌有效期至 {plan.expiresAt ? date(plan.expiresAt) : "—"}，仅可使用一次。</small></section></div> : null}
    {notice ? <div className={styles.toast}><Check size={14} />{notice}</div> : null}
  </main>;
}

function Loading({ label }: { label: string }) {
  return <div className={styles.loading}><LoaderCircle className={styles.spin} size={19} /><span>{label}</span></div>;
}

function DiffView({ files, active, onSelect }: { files: PullRequestFile[]; active?: PullRequestFile; onSelect: (path: string) => void }) {
  return <div className={styles.codeWorkspace}>
    <aside className={styles.fileRail}><div className={styles.fileRailHead}><FileCode2 size={13} />CHANGED FILES <span>{files.length}</span></div>{files.map((file) => <button key={file.path} className={active?.path === file.path ? styles.activeFile : ""} onClick={() => onSelect(file.path)}><span className={styles.fileStatus}>{file.status.slice(0, 1).toUpperCase()}</span><b>{file.path}</b><small><i>+{file.additions}</i><em>−{file.deletions}</em></small></button>)}</aside>
    <div className={styles.patchPane}>{active ? <><header><span>{active.path}</span><small>+{active.additions} −{active.deletions}</small></header>{active.patch ? <pre>{active.patch.split("\n").map((line, index) => <span key={`${index}-${line.slice(0, 12)}`} className={line.startsWith("+") && !line.startsWith("+++") ? styles.lineAdd : line.startsWith("-") && !line.startsWith("---") ? styles.lineDel : line.startsWith("@@") ? styles.lineHunk : ""}><i>{index + 1}</i><code>{line || " "}</code></span>)}</pre> : <div className={styles.noPatch}>GitHub 未提供这个文件的文本补丁，可能是二进制或补丁过大。</div>}</> : null}</div>
  </div>;
}

function SourceView({ rows, active, loading, onSelect }: { rows: SourceComparison[]; active?: SourceComparison; loading: boolean; onSelect: (path: string) => void }) {
  if (loading) return <Loading label="按仓库策略读取受限源码上下文" />;
  if (!rows.length) return <div className={styles.noSource}><ShieldAlert size={20} /><b>没有可读取的源码上下文</b><p>二进制、生成物、锁文件和超过仓库策略上限的内容会被跳过。</p></div>;
  return <div className={styles.sourceWorkspace}><div className={styles.sourceSelect}><label>文件 <span><select value={active?.path || ""} onChange={(event) => onSelect(event.target.value)}>{rows.map((row) => <option key={row.path}>{row.path}</option>)}</select><ChevronDown size={13} /></span></label><small>{active?.truncated ? "内容已按字节上限截断" : "完整读取到允许范围"}</small></div><div className={styles.sourceColumns}><section><header>BASE · 变更前</header><pre>{active?.base || "（文件不存在或不可读）"}</pre></section><section><header>HEAD · 变更后</header><pre>{active?.head || "（文件不存在或不可读）"}</pre></section></div></div>;
}

function ChecksView({ detail }: { detail: DetailResponse }) {
  return <div className={styles.checksWorkspace}><section><header><b>CI Checks</b><span>{detail.bundle.checks.length}</span></header>{detail.bundle.checks.length ? detail.bundle.checks.map((check) => <div key={check.name}>{check.passing ? <CheckCircle2 size={15} /> : <XCircle size={15} />}<span><b>{check.name}</b><small>{check.status} · {check.conclusion}</small></span></div>) : <p>GitHub 没有返回可验证的 CI 检查；默认策略会阻止合并。</p>}</section><section><header><b>Reviews</b><span>{detail.bundle.reviews.length}</span></header>{detail.bundle.reviews.length ? detail.bundle.reviews.map((review, index) => <div key={`${review.author}-${index}`}><span className={styles.reviewAvatar}>{review.author.slice(0, 2).toUpperCase()}</span><span><b>{review.author}</b><small>{review.state}{review.submittedAt ? ` · ${date(review.submittedAt)}` : ""}</small></span></div>) : <p>还没有评审记录；默认策略要求至少一个批准。</p>}</section><section className={styles.branchFact}><header><b>Branch protection</b></header><p>{detail.bundle.branchProtection.known ? `GitHub 返回的最低批准数：${detail.bundle.branchProtection.requiredApprovals ?? 0}` : `保护规则不可确认：${detail.bundle.branchProtection.reason || "权限不足或未配置"}`}</p></section></div>;
}

function Verdict({ review }: { review: AiMergeReview | null }) {
  if (!review) return <section className={styles.verdictEmpty}><Bot size={22} /><b>尚未生成 AI 结论</b><p>审查 Agent 只比较当前补丁和允许读取的局部源码；CI、评审和项目完整性由独立合并门禁处理。</p></section>;
  const merge = review.verdict === "merge";
  return <section className={`${styles.verdict} ${merge ? styles.verdictMerge : styles.verdictHold}`}><div className={styles.verdictTop}><span>{merge ? <CheckCircle2 size={18} /> : <ShieldAlert size={18} />}{verdictLabel(review.verdict)}</span><b>{Math.round(review.confidence * 100)}%</b></div><p>{review.summary}</p><small>审查提交 {review.reviewedHeadSha.slice(0, 8)} · {date(review.reviewedAt)} · 仅评价当前变更，不代表项目完整或已满足合并门禁</small>{review.findings.length ? <div className={styles.findings}>{review.findings.slice(0, 6).map((finding, index) => <article key={`${finding.title}-${index}`}><em data-severity={finding.severity}>{finding.severity}</em><b>{finding.title}</b><p>{finding.explanation}</p>{finding.file ? <code>{finding.file}{finding.line ? `:${finding.line}` : ""}</code> : null}</article>)}</div> : null}</section>;
}

function PolicyDialog({ policy, repository, busy, onChange, onClose, onSave }: { policy: RepositoryMergePolicy; repository: string; busy: boolean; onChange: (value: RepositoryMergePolicy) => void; onClose: () => void; onSave: () => void }) {
  const set = <K extends keyof RepositoryMergePolicy>(key: K, value: RepositoryMergePolicy[K]) => onChange({ ...policy, [key]: value });
  return <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className={styles.policyModal} role="dialog" aria-modal="true" aria-labelledby="policy-title"><header><div><span>REPOSITORY MERGE POLICY</span><h2 id="policy-title">{repository}</h2><p>这些规则由服务端确定性执行，AI 无法修改或跳过。</p></div><button onClick={onClose}><X size={16} /></button></header><div className={styles.policyGrid}><label>合并方式<select value={policy.mergeMethod} onChange={(event) => set("mergeMethod", event.target.value as RepositoryMergePolicy["mergeMethod"])}><option value="squash">Squash</option><option value="merge">Merge commit</option><option value="rebase">Rebase</option></select></label><label>最低 AI 置信度<input type="number" min="0.5" max="1" step="0.05" value={policy.minimumAiConfidence} onChange={(event) => set("minimumAiConfidence", Number(event.target.value))} /></label><label>最大文件数<input type="number" min="1" max="500" value={policy.maxFiles} onChange={(event) => set("maxFiles", Number(event.target.value))} /></label><label>最大变更行数<input type="number" min="1" max="100000" value={policy.maxChangedLines} onChange={(event) => set("maxChangedLines", Number(event.target.value))} /></label></div><div className={styles.policyChecks}><label><input type="checkbox" checked={policy.requireChecks} onChange={(event) => set("requireChecks", event.target.checked)} /><span><b>要求 CI 检查</b><small>没有可验证检查时阻止合并</small></span></label><label><input type="checkbox" checked={policy.requireReview} onChange={(event) => set("requireReview", event.target.checked)} /><span><b>要求批准评审</b><small>至少一个最新 APPROVED</small></span></label><label><input type="checkbox" checked={policy.blockChangesRequested} onChange={(event) => set("blockChangesRequested", event.target.checked)} /><span><b>阻止修改请求</b><small>CHANGES_REQUESTED 未解除时阻止</small></span></label><label><input type="checkbox" checked={policy.blockDraft} onChange={(event) => set("blockDraft", event.target.checked)} /><span><b>阻止草稿 PR</b><small>Draft 不能进入合并计划</small></span></label></div><label className={styles.pathPolicy}>人工专审路径<textarea value={policy.manualOnlyPaths.join("\n")} onChange={(event) => set("manualOnlyPaths", event.target.value.split("\n").map((item) => item.trim()).filter(Boolean))} /><small>每行一个前缀。命中后只能先调整策略或完成额外人工复核。</small></label><footer><button className={styles.cancelButton} onClick={onClose}>取消</button><button className={styles.saveButton} disabled={busy} onClick={onSave}>{busy ? <LoaderCircle className={styles.spin} size={15} /> : <Check size={15} />}保存策略</button></footer></section></div>;
}
