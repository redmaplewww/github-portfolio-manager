"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Activity, ArrowUpRight, BookOpen, Bot, Check, ChevronRight, CircleAlert, Clock3, Code2, GitMerge, GitPullRequest, Github, Layers3, LoaderCircle, RefreshCw, Search, Settings2, ShieldCheck, UserRoundPlus, UsersRound, X } from "lucide-react";
import styles from "./github-portfolio-workbench.module.css";

type Repository = { nameWithOwner: string; description?: string; visibility?: string; updatedAt?: string | null; url?: string; archived?: boolean };
type Contributor = { login: string; touchedPullRequests: number; opened: number; merged: number; currentlyOpen: number; additions: number; deletions: number; changedFiles: number; commits: number; reviewsSubmitted: number };
type Summary = { generatedAt: string; window: { since: string; until: string }; totals: Record<string, number>; repositories: Array<{ repository: Repository; counts: Record<string, number>; contributors: Contributor[]; assignments: Array<{ login: string; responsibility: string; notes: string }>; prQueue: Array<{ number: number; title: string; url: string; author: string; reviewDecision: string; stale: boolean; draft: boolean; updatedAt: string }> }>; contributors: Contributor[]; failures: Array<{ repository: string; error: string }>; metricNotice: string; reportFiles?: { markdownPath?: string; jsonPath?: string } };
type Status = { authentication?: { authenticated?: boolean; login?: string | null; error?: string }; trackedRepositories: string[]; reporting: { enabled: boolean; cadence: string; timezone: string; destination: string; lastSummaryAt?: string | null }; assignmentRepositoryCount: number };
type OverviewReview = { verdict: "merge" | "needs_changes" | "manual_review" | "insufficient_evidence"; confidence: number; summary: string; findings: Array<{ severity: string; title: string }>; reviewedHeadSha: string; reviewedAt: string; model: string };

const fmt = (value: number) => new Intl.NumberFormat("zh-CN", { notation: value > 9999 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value || 0);
const shortDate = (value?: string | null) => value ? new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value)) : "—";
const initials = (login: string) => login.slice(0, 2).toUpperCase();
const overviewVerdictLabel = (verdict: OverviewReview["verdict"]) => verdict === "merge" ? "未见代码阻断" : verdict === "needs_changes" ? "发现代码风险" : verdict === "manual_review" ? "需要补充局部证据" : "当前证据不足";

const demoRepositories: Repository[] = [
  { nameWithOwner: "redmaplewww/github-portfolio-manager", description: "GitHub 仓库与 Pull Request 管理", visibility: "public", updatedAt: new Date().toISOString(), url: "https://github.com/redmaplewww/github-portfolio-manager" },
  { nameWithOwner: "redmaplewww/project-to-act", description: "证据驱动的项目治理账本", visibility: "public", updatedAt: new Date(Date.now() - 86400000 * 2).toISOString(), url: "https://github.com/redmaplewww/project-to-act" },
  { nameWithOwner: "redmaplewww/skill-thinker", description: "技能候选与工作流复盘", visibility: "public", updatedAt: new Date(Date.now() - 86400000 * 5).toISOString(), url: "https://github.com/redmaplewww/skill-thinker" },
];

function formatError(value: unknown, fallback = "请求失败") {
  if (typeof value === "string" && value.trim() && value !== "[object Object]") return value;
  if (value === "[object Object]") return fallback;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["message", "error", "detail", "reason"]) {
      if (typeof record[key] === "string" && String(record[key]).trim()) return String(record[key]);
    }
    try { return JSON.stringify(value); } catch { return fallback; }
  }
  return value == null ? fallback : String(value);
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store", headers: { "content-type": "application/json", ...(init?.headers || {}) } });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(formatError(payload.error, `请求失败（HTTP ${response.status}）`));
  return payload.data as T;
}

export function GithubPortfolioWorkbench() {
  const [tab, setTab] = useState<"overview" | "repositories" | "people" | "reporting">("overview");
  const [status, setStatus] = useState<Status | null>(null);
  const [discovered, setDiscovered] = useState<Repository[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [assignments, setAssignments] = useState<Record<string, Array<{ login: string; responsibility: string; notes: string }>>>({});
  const [aiReviews, setAiReviews] = useState<Record<string, OverviewReview>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoReviewStarted = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const nextStatus = await api<Status>("/api/v1/github-portfolio?action=status");
      setStatus(nextStatus);
      const [repos, stateAssignments] = await Promise.all([
        api<{ repositories: Repository[] }>("/api/v1/github-portfolio?action=discover&limit=100"),
        api<Record<string, Array<{ login: string; responsibility: string; notes: string }>>>("/api/v1/github-portfolio?action=assignments"),
      ]);
      setDiscovered(repos.repositories || []); setAssignments(stateAssignments || {});
      if (nextStatus.trackedRepositories.length) setSummary(await api<Summary>("/api/v1/github-portfolio?action=summary&since=30d"));
      else setSummary(null);
      try {
        const storedReviews = await api<Record<string, OverviewReview>>("/api/v1/github-portfolio/pull-requests?action=overview-reviews");
        const normalizedReviews = Object.fromEntries(Object.entries(storedReviews).map(([cacheKey, review]) => {
          const parts = cacheKey.split("#");
          return [`${parts[0]}#${parts[1]}`, review];
        }));
        setAiReviews(normalizedReviews);
      } catch { setAiReviews({}); }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "GitHub 数据暂时不可用");
      setDiscovered(demoRepositories);
    } finally { setLoading(false); }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 3500); return () => window.clearTimeout(timer); }, [toast]);

  const tracked = status?.trackedRepositories || [];
  const repoMap = useMemo(() => new Map([...demoRepositories, ...discovered].map((repo) => [repo.nameWithOwner, repo])), [discovered]);
  const queue = useMemo(() => (summary?.repositories || []).flatMap((repo) => repo.prQueue.map((pull) => ({ ...pull, repository: repo.repository.nameWithOwner }))).slice(0, 8), [summary]);
  const contributors = summary?.contributors || [];
  const totalLines = contributors.reduce((sum, person) => sum + person.additions + person.deletions, 0);
  const reviewLoad = summary?.totals.awaitingReview || 0;
  const reviewKey = (repository: string, number: number) => `${repository}#${number}`;

  const generateAiSummary = async (pull: (typeof queue)[number]) => {
    const key = reviewKey(pull.repository, pull.number);
    setBusy(`ai:${key}`); setError(null);
    try {
      const result = await api<{ review: OverviewReview }>("/api/v1/github-portfolio/pull-requests", { method: "POST", body: JSON.stringify({ action: "ai-review", repository: pull.repository, number: pull.number }) });
      setAiReviews((current) => ({ ...current, [key]: result.review }));
      setToast(`PR #${pull.number} 的 AI 速评已生成`);
    } catch (cause) { setError(formatError(cause instanceof Error ? cause.message : cause, "AI 速评生成失败")); }
    finally { setBusy(null); }
  };

  // Warm only the first few uncached reviews after the page is usable. This keeps
  // startup responsive while making the overview self-contained over time.
  useEffect(() => {
    if (loading || autoReviewStarted.current || !queue.length) return;
    const pending = queue.filter((pull) => !aiReviews[reviewKey(pull.repository, pull.number)]).slice(0, 3);
    if (!pending.length) return;
    autoReviewStarted.current = true;
    void (async () => {
      for (const pull of pending) await generateAiSummary(pull);
    })();
    // The ref intentionally gates this background warm-up to one pass per page mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, queue, aiReviews]);

  const mutate = async (action: string, body: Record<string, unknown>, message: string) => {
    setBusy(action); setError(null);
    try { await api(`/api/v1/github-portfolio`, { method: "POST", body: JSON.stringify({ action, ...body }) }); setToast(message); void refresh(); return true; }
    catch (cause) { setError(formatError(cause instanceof Error ? cause.message : cause, "操作未完成")); return false; }
    finally { setBusy(null); }
  };

  const commitSelection = () => void mutate("track", { repositories: selected, mode: "replace" }, `已将 ${selected.length} 个仓库加入追踪` ).then((ok) => { if (ok) setShowPicker(false); });
  const repoCards = (tracked.length ? tracked : discovered.slice(0, 3).map((repo) => repo.nameWithOwner)).map((name) => repoMap.get(name) || { nameWithOwner: name });

  return <main className={styles.shell}>
    <header className={styles.topbar}>
      <div className={styles.brand}><span className={styles.brandMark}><Github size={19} /></span><span><b>代码版图</b><small>GitHub portfolio control</small></span></div>
      <div className={styles.topbarRight}><Link className={styles.reviewLink} href="/github/review"><GitMerge size={14} />PR 审查台</Link><span className={styles.identity}><span className={styles.statusDot} />{status?.authentication?.login || "未连接 GitHub"}</span><button className={styles.iconButton} onClick={() => void refresh()} aria-label="刷新数据"><RefreshCw size={16} className={loading ? styles.spin : ""} /></button></div>
    </header>
    <section className={styles.page}>
      <div className={styles.eyebrow}><span>WORKSPACE / GITHUB</span><span className={styles.connectionPill}>{status?.authentication?.authenticated ? <><span className={styles.liveDot} />实时读取</> : "等待连接"}</span></div>
      <div className={styles.hero}><div><h1>选定的代码版图</h1><p>把仓库、PR、协作者和工作量事实放在同一张可追踪的开发进度纸上。</p></div><button className={styles.primaryButton} onClick={() => { setSelected(tracked); setShowPicker(true); }}><Layers3 size={16} />管理追踪范围</button></div>
      {error ? <div className={styles.notice}><CircleAlert size={16} /><span><b>连接状态需要确认</b>{error}</span><button onClick={() => setError(null)} aria-label="关闭提示"><X size={15} /></button></div> : null}
      <div className={styles.signalSpine}>
        <div><span className={styles.signalIcon}><BookOpen size={16} /></span><span><small>追踪仓库</small><strong>{tracked.length}</strong></span><em>{tracked.length ? "范围已选定" : "尚未选定"}</em></div>
        <div><span className={styles.signalIcon}><GitPullRequest size={16} /></span><span><small>当前打开 PR</small><strong>{fmt(summary?.totals.currentlyOpen || 0)}</strong></span><em className={reviewLoad ? styles.warnText : ""}>{reviewLoad ? `${reviewLoad} 个待审` : "队列平稳"}</em></div>
        <div><span className={styles.signalIcon}><UsersRound size={16} /></span><span><small>活跃贡献者</small><strong>{contributors.length || Object.keys(assignments).length}</strong></span><em>{totalLines ? `${fmt(totalLines)} 行变更` : "等待首份摘要"}</em></div>
        <div><span className={styles.signalIcon}><Clock3 size={16} /></span><span><small>报告节奏</small><strong>{status?.reporting?.enabled ? "已开启" : "未开启"}</strong></span><em>{status?.reporting?.cadence === "weekly" ? "每周" : status?.reporting?.cadence || "可配置"}</em></div>
      </div>
      <nav className={styles.tabs} aria-label="代码版图模块">{([["overview", "总览", Activity], ["repositories", "仓库轨道", BookOpen], ["people", "成员账本", UsersRound], ["reporting", "报告设置", Settings2]] as const).map(([id, label, Icon]) => <button key={id} className={tab === id ? styles.activeTab : ""} onClick={() => setTab(id)}><Icon size={15} />{label}{id === "overview" && queue.length ? <b>{queue.length}</b> : null}</button>)}</nav>
      {tab === "overview" ? <div className={styles.grid}>
        <section className={`${styles.panel} ${styles.mainPanel}`}><header className={styles.panelHead}><div><span className={styles.kicker}>PR QUEUE / 30 DAYS</span><h2>需要你看一眼的变化</h2><p>{summary ? `上次读取 ${shortDate(summary.generatedAt)} · ${summary.window.since.slice(0, 10)} 至 ${summary.window.until.slice(0, 10)}` : "选定仓库后，这里会按周期聚合 PR 的真实活动。"}</p></div><span className={styles.panelCount}>{queue.length ? `${queue.length} 条` : "空队列"}</span></header>{queue.length ? <div className={styles.queue}>{queue.map((pull) => { const ai = aiReviews[reviewKey(pull.repository, pull.number)]; const aiBusy = busy === `ai:${reviewKey(pull.repository, pull.number)}`; return <article key={`${pull.repository}-${pull.number}`} className={styles.queueItem}><span className={`${styles.prState} ${pull.stale ? styles.prStale : ""}`}><GitPullRequest size={14} />#{pull.number}</span><div className={styles.queueCopy}><a href={pull.url} target="_blank" rel="noreferrer">{pull.title}</a><p>{pull.repository} · {pull.author} · 更新于 {shortDate(pull.updatedAt)}</p><div className={styles.aiQuick}><Bot size={13} /><span>{ai ? <><b className={ai.verdict === "merge" ? styles.aiGood : styles.aiWarn}>{overviewVerdictLabel(ai.verdict)}</b><em>{Math.round(ai.confidence * 100)}% · {ai.summary}</em></> : <em>尚未生成 AI 速评</em>}</span>{ai ? null : <button onClick={() => void generateAiSummary(pull)} disabled={aiBusy}>{aiBusy ? <LoaderCircle size={12} className={styles.spin} /> : "生成速评"}</button>}</div></div><span className={pull.stale ? styles.badgeWarn : styles.badge}>{pull.stale ? "超期" : pull.reviewDecision === "CHANGES_REQUESTED" ? "需修改" : pull.draft ? "草稿" : "待处理"}</span></article>; })}</div> : <EmptyState tracked={tracked.length} onPick={() => { setSelected(tracked); setShowPicker(true); }} />}</section>
        <aside className={styles.sideStack}><section className={styles.ledgerPanel}><header className={styles.panelHead}><div><span className={styles.kicker}>WORKLOAD LEDGER</span><h2>成员工作量事实</h2></div><span className={styles.panelCount}>{contributors.length || "—"}</span></header>{contributors.length ? <div className={styles.peopleList}>{contributors.slice(0, 5).map((person) => <PersonRow key={person.login} person={person} />)}</div> : <p className={styles.muted}>完成首份摘要后，按 PR、评审、提交与增删行展示活动事实。<br /><small>不自动等同绩效评分。</small></p>}</section><section className={styles.darkPanel}><ShieldCheck size={18} /><div><b>边界清楚，动作可审计</b><p>读取 GitHub 事实；成员权限变更仍需先生成计划，再由你确认。</p><button onClick={() => setTab("people")}>查看协作者管理 <ArrowUpRight size={13} /></button></div></section></aside>
      </div> : tab === "repositories" ? <RepositoriesTab repos={repoCards} tracked={tracked} assignments={assignments} onManage={() => { setSelected(tracked); setShowPicker(true); }} /> : tab === "people" ? <PeopleTab repos={repoCards} summary={summary} assignments={assignments} busy={busy} onAssign={(repository, login) => void mutate("assign", { repository, login, responsibility: "contributor", mode: "upsert" }, "已记录仓库分工")} /> : <ReportingTab status={status} disabled={busy !== null} onSave={(body) => void mutate("reporting", body, "报告节奏已保存")} />}
    </section>
    {showPicker ? <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowPicker(false); }}><section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="picker-title"><header><div><span className={styles.kicker}>TRACKING SCOPE</span><h2 id="picker-title">选择要追踪的仓库</h2><p>只会读取你勾选的仓库，报告也只围绕这个范围生成。</p></div><button onClick={() => setShowPicker(false)} aria-label="关闭"><X size={17} /></button></header><div className={styles.repoPicker}>{(discovered.length ? discovered : demoRepositories).map((repo) => <label key={repo.nameWithOwner} className={styles.repoOption}><input type="checkbox" checked={selected.includes(repo.nameWithOwner)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, repo.nameWithOwner] : current.filter((name) => name !== repo.nameWithOwner))} /><span className={styles.repoGlyph}><Code2 size={15} /></span><span><b>{repo.nameWithOwner}</b><small>{repo.description || "无描述"}</small></span><em>{repo.visibility || "public"}</em></label>)}</div><footer><span>{selected.length} 个仓库已选</span><button className={styles.primaryButton} disabled={busy === "track"} onClick={commitSelection}>{busy === "track" ? <LoaderCircle size={15} className={styles.spin} /> : <Check size={15} />}保存追踪范围</button></footer></section></div> : null}
    {toast ? <div className={styles.toast}><Check size={15} />{toast}</div> : null}
  </main>;
}

function EmptyState({ tracked, onPick }: { tracked: number; onPick: () => void }) { return <div className={styles.emptyState}><span className={styles.emptyGlyph}><Search size={20} /></span><h3>{tracked ? "正在准备第一份摘要" : "先选定你的代码版图"}</h3><p>{tracked ? "GitHub 正在读取 PR 活动，完成后会出现在这里。" : "从已授权的 GitHub 仓库中勾选项目，插件会按周期聚合进度。"}</p><button className={styles.secondaryButton} onClick={onPick}><Layers3 size={14} />选择仓库</button></div>; }
function PersonRow({ person }: { person: Contributor }) { return <article className={styles.personRow}><span className={styles.avatar}>{initials(person.login)}</span><div><b>{person.login}</b><small>{person.touchedPullRequests} 个活跃 PR · {person.reviewsSubmitted} 次评审</small></div><span className={styles.personStats}><strong>{fmt(person.additions + person.deletions)}</strong><small>行变更</small></span></article>; }
function RepositoriesTab({ repos, tracked, assignments, onManage }: { repos: Repository[]; tracked: string[]; assignments: Record<string, Array<{ login: string }>>; onManage: () => void }) { return <section className={styles.singleColumn}><div className={styles.sectionIntro}><div><span className={styles.kicker}>REPOSITORY RAIL</span><h2>仓库轨道</h2><p>每个仓库都是一条独立的进度线；先管理范围，再查看 PR 和成员分工。</p></div><button className={styles.secondaryButton} onClick={onManage}><Settings2 size={14} />调整追踪范围</button></div><div className={styles.repoGrid}>{repos.map((repo) => <article className={styles.repoCard} key={repo.nameWithOwner}><div className={styles.repoCardHead}><span className={styles.repoGlyph}><Code2 size={16} /></span><span className={styles.repoTitle}><b>{repo.nameWithOwner.split("/")[1]}</b><small>{repo.nameWithOwner.split("/")[0]}</small></span><span className={tracked.includes(repo.nameWithOwner) ? styles.badgeGood : styles.badge}>{tracked.includes(repo.nameWithOwner) ? "追踪中" : "候选"}</span></div><p>{repo.description || "暂无仓库描述"}</p><div className={styles.repoMeta}><span><Activity size={13} />更新 {shortDate(repo.updatedAt)}</span><span><UsersRound size={13} />{assignments[repo.nameWithOwner]?.length || 0} 人分工</span></div><a href={repo.url || `https://github.com/${repo.nameWithOwner}`} target="_blank" rel="noreferrer">打开 GitHub <ArrowUpRight size={13} /></a></article>)}</div></section>; }
function PeopleTab({ repos, summary, assignments, busy, onAssign }: { repos: Repository[]; summary: Summary | null; assignments: Record<string, Array<{ login: string; responsibility: string }>>; busy: string | null; onAssign: (repository: string, login: string) => void }) { const [repo, setRepo] = useState(repos[0]?.nameWithOwner || ""); const [login, setLogin] = useState(""); const people = summary?.contributors || []; return <section className={styles.peopleLayout}><div className={styles.panel}><header className={styles.panelHead}><div><span className={styles.kicker}>CONTRIBUTION FACTS</span><h2>成员账本</h2><p>用可追溯的 GitHub 活动事实辅助复盘，不把代码量直接当成绩效分数。</p></div><span className={styles.panelCount}>{people.length} 人</span></header>{people.length ? <div className={styles.contributorTable}>{people.map((person) => <div key={person.login} className={styles.contributorLine}><span className={styles.avatar}>{initials(person.login)}</span><b>{person.login}</b><span>{person.touchedPullRequests} PR</span><span>{person.merged} 合并</span><span>{fmt(person.additions)} / {fmt(person.deletions)} 行</span><span>{person.reviewsSubmitted} 评审</span></div>)}</div> : <div className={styles.emptyInline}><UsersRound size={18} />还没有可汇总的活动事实；先追踪一个仓库并生成摘要。</div>}</div><aside className={styles.assignmentPanel}><header><span className={styles.kicker}>ASSIGNMENTS</span><h3>仓库分工</h3><p>把责任人记录在组合状态中，后续摘要会提示活跃但未分配的人。</p></header><div className={styles.assignmentList}>{repos.map((item) => <article key={item.nameWithOwner}><div><b>{item.nameWithOwner}</b><small>{assignments[item.nameWithOwner]?.length || 0} 位成员</small></div>{assignments[item.nameWithOwner]?.length ? <span>{assignments[item.nameWithOwner].map((person) => person.login).join(" · ")}</span> : <em>尚未分配</em>}</article>)}</div><div className={styles.assignForm}><label>仓库<select value={repo} onChange={(event) => setRepo(event.target.value)}>{repos.map((item) => <option key={item.nameWithOwner}>{item.nameWithOwner}</option>)}</select></label><label>GitHub 登录名<input value={login} onChange={(event) => setLogin(event.target.value)} placeholder="例如 octocat" /></label><button className={styles.primaryButton} disabled={!repo || !login.trim() || busy === "assign"} onClick={() => { onAssign(repo, login.trim()); setLogin(""); }}><UserRoundPlus size={15} />记录分工</button></div></aside></section>; }
function ReportingTab({ status, disabled, onSave }: { status: Status | null; disabled: boolean; onSave: (body: Record<string, unknown>) => void }) { const [enabled, setEnabled] = useState(Boolean(status?.reporting.enabled)); const [cadence, setCadence] = useState(status?.reporting.cadence || "weekly"); const [destination, setDestination] = useState(status?.reporting.destination || "current Codex task"); return <section className={styles.reportingLayout}><div className={`${styles.panel} ${styles.reportHero}`}><span className={styles.kicker}>REPORTING CADENCE</span><h2>让摘要自己来到你面前</h2><p>插件会在你明确选择仓库、节奏和目的地后，生成周期性 PR 摘要。默认关闭，不会暗中推送。</p><div className={styles.reportFlow}><span><b>01</b><small>读取追踪仓库</small></span><ChevronRight size={15} /><span><b>02</b><small>聚合 PR 与成员事实</small></span><ChevronRight size={15} /><span><b>03</b><small>发送到指定目的地</small></span></div></div><form className={styles.panel} onSubmit={(event) => { event.preventDefault(); onSave({ enabled, cadence, timezone: status?.reporting.timezone || "Asia/Shanghai", destination }); }}><div className={styles.formHead}><div><span className={styles.kicker}>CONTROL</span><h3>报告控制</h3></div><span className={enabled ? styles.badgeGood : styles.badge}>默认关闭</span></div><label className={styles.toggleRow}><span><b>启用周期报告</b><small>只有追踪范围非空时才允许开启</small></span><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /></label><label>发送节奏<select value={cadence} onChange={(event) => setCadence(event.target.value)}><option value="daily">每天</option><option value="weekly">每周</option><option value="monthly">每月</option></select></label><label>目的地<input value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="当前 Codex task / 你的通知渠道" /></label><button className={styles.primaryButton} disabled={disabled}><Check size={15} />保存报告设置</button><p className={styles.formNote}><ShieldCheck size={14} />上次报告：{status?.reporting.lastSummaryAt ? shortDate(status.reporting.lastSummaryAt) : "尚未生成"} · 时区 Asia/Shanghai</p></form></section>; }
