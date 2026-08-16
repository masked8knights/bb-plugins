import {Audio} from "@remotion/media";
import {AbsoluteFill, Easing, interpolate, staticFile, useCurrentFrame} from "remotion";
import type {CSSProperties, ReactNode} from "react";
import {FPS, HEIGHT, WIDTH} from "./Video";

export const PODCAST_DURATION_IN_FRAMES = 4755;

const FONT_FAMILY =
  "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif";

const COLORS = {
  background: "#0a111d",
  backgroundRaised: "#101d2e",
  panel: "#14243a",
  panelRaised: "#1a2e47",
  line: "#2b4564",
  lineSoft: "#20354e",
  ink: "#f1f6fc",
  muted: "#a6b7ca",
  faint: "#758ba5",
  host: "#f4c875",
  hostSoft: "#4a3a20",
  explainer: "#61d7ef",
  explainerSoft: "#193e55",
  green: "#83e3ae",
  greenSoft: "#173f38",
  purple: "#b9a9ff",
  purpleSoft: "#302b5d",
  coral: "#ff9b8f",
  coralSoft: "#4c2a31",
};

type Role = "HOST" | "EXPLAINER";

type CaptionCue = {
  start: number;
  end: number;
  role: Role;
  text: string;
};

const CUES: CaptionCue[] = [
  {start: 0, end: 329, role: "HOST", text: "The agent says the work is done. I come back to the thread later, and I still do not know what changed. Is that the problem this plugin solves?"},
  {start: 338, end: 750, role: "EXPLAINER", text: "Yes. It adds a handoff layer. The agent can return a correct result while the person receiving it still lacks the story: what changed, why the approach was chosen, and what needs attention."},
  {start: 767, end: 865, role: "HOST", text: "Then why not start with the diff?"},
  {start: 874, end: 1441, role: "EXPLAINER", text: "A diff shows what moved in files. It does not show which parts matter. Comprehension starts with a question and a scope: the full thread, one message, or a selected passage. That choice controls how much context the worker must explain."},
  {start: 1458, end: 1552, role: "HOST", text: "What happens after I choose that scope?"},
  {start: 1561, end: 2063, role: "EXPLAINER", text: "The server takes a bounded snapshot. It finds the matching thread rows, preserves their order, applies the source limit, and records the conversation point. The worker receives that frozen input. It is not reading a live thread while you watch."},
  {start: 2080, end: 2173, role: "HOST", text: "Who actually writes the explanation?"},
  {start: 2182, end: 2678, role: "EXPLAINER", text: "A hidden child thread. It receives the snapshot, the report skill, and the Quiet Newsroom template. It turns those inputs into one standalone H T M L report. The host validates and stores it, so the slow reading happens out of your way."},
  {start: 2695, end: 2788, role: "HOST", text: "What does that report give me when I return?"},
  {start: 2797, end: 3309, role: "EXPLAINER", text: "It gives you a place to start. You get a title, a table of contents, open sections, diagrams, and a view you can reopen or embed. It makes the system shape visible without asking you to reconstruct it from raw messages."},
  {start: 3327, end: 3508, role: "HOST", text: "That sounds useful, but it still sounds static. What am I missing?"},
  {start: 3518, end: 3975, role: "EXPLAINER", text: "You are missing time and state. The report can explain how the system works, but it does not yet say what changed during this run, which decision was hard, what evidence supports it, or what you should do next."},
  {start: 3992, end: 4094, role: "HOST", text: "So what would the next version sound like?"},
  {start: 4104, end: 4746, role: "EXPLAINER", text: "It would sound like a briefing, not a document. A host could ask the questions that appear when you step back in. An explainer could answer with the current status, the relevant context, the change, the evidence, and the next action. The same brief could become H T M L, narrated slides, a player, or a video."},
];

const CHAPTERS = [
  {start: 0, end: 750, label: "THE HANDOFF", title: "The result is done. The story is not.", prompt: "Why does a finished agent task still need explanation?"},
  {start: 750, end: 1458, label: "THE QUESTION", title: "Start with the question, not the diff.", prompt: "What do you actually want the worker to explain?"},
  {start: 1458, end: 2080, label: "THE SNAPSHOT", title: "Freeze the context before you explain it.", prompt: "What does the worker see?"},
  {start: 2080, end: 2695, label: "THE WORKER", title: "A hidden worker turns context into a report.", prompt: "Who does the slow reading?"},
  {start: 2695, end: 3327, label: "THE REPORT", title: "The report gives you a place to start.", prompt: "What comes back when you return?"},
  {start: 3327, end: 3992, label: "THE GAP", title: "Explanation is not the same as orientation.", prompt: "What is still missing from a static report?"},
  {start: 3992, end: PODCAST_DURATION_IN_FRAMES, label: "THE BRIEF", title: "Make the handoff sound like a briefing.", prompt: "What should the next artifact do?"},
];

const basePanel: CSSProperties = {
  backgroundColor: COLORS.panel,
  border: `1px solid ${COLORS.line}`,
  borderRadius: 14,
};

const labelStyle: CSSProperties = {
  color: COLORS.faint,
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: 1.7,
};

function reveal(frame: number, delay = 0, duration = 22) {
  return interpolate(frame, [delay, delay + duration], [0, 1], {
    easing: Easing.out(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

function lift(frame: number, delay = 0, distance = 14): CSSProperties {
  const progress = reveal(frame, delay);
  return {opacity: progress, transform: `translateY(${(1 - progress) * distance}px)`};
}

function Panel({children, style, accent}: {children: ReactNode; style?: CSSProperties; accent?: string}) {
  return <div style={{...basePanel, ...(accent ? {borderColor: accent} : {}), ...style}}>{children}</div>;
}

function Tag({children, color, soft}: {children: ReactNode; color: string; soft: string}) {
  return (
    <span style={{display: "inline-flex", alignItems: "center", gap: 7, padding: "6px 9px", borderRadius: 7, backgroundColor: soft, color, fontSize: 10, fontWeight: 850, letterSpacing: 1.25}}>
      <span style={{width: 6, height: 6, borderRadius: "50%", backgroundColor: color}} />
      {children}
    </span>
  );
}

function Arrow({left, top, width = 75, color = COLORS.explainer}: {left: number; top: number; width?: number; color?: string}) {
  return (
    <div style={{position: "absolute", left, top, width, height: 24, display: "flex", alignItems: "center", color}}>
      <div style={{height: 2, flex: 1, backgroundColor: color}} />
      <div style={{width: 0, height: 0, borderTop: "6px solid transparent", borderBottom: "6px solid transparent", borderLeft: `9px solid ${color}`}} />
    </div>
  );
}

function StageFrame({chapter, frame, children}: {chapter: (typeof CHAPTERS)[number]; frame: number; children: ReactNode}) {
  return (
    <div style={{position: "absolute", left: 72, top: 185, width: WIDTH - 144, height: 355}}>
      <div style={{display: "flex", alignItems: "baseline", gap: 18, ...lift(frame)}}>
        <span style={{...labelStyle, color: COLORS.explainer}}>{chapter.label}</span>
        <span style={{color: COLORS.faint, fontSize: 13}}>{chapter.prompt}</span>
      </div>
      <div style={{marginTop: 13, color: COLORS.ink, fontSize: 28, fontWeight: 730, letterSpacing: -0.5, ...lift(frame, 5)}}>{chapter.title}</div>
      <div style={{position: "absolute", left: 0, right: 0, top: 84, height: 266}}>{children}</div>
    </div>
  );
}

function HandoffStage({frame}: {frame: number}) {
  const questions = ["What changed?", "Why this approach?", "What needs my attention?"];
  return (
    <>
      <Panel style={{position: "absolute", left: 0, top: 0, width: 405, height: 238, padding: 22, ...lift(frame, 10)}} accent={COLORS.green}>
        <Tag color={COLORS.green} soft={COLORS.greenSoft}>AGENT FINISHED</Tag>
        <div style={{marginTop: 19, color: COLORS.ink, fontSize: 24, fontWeight: 720}}>Changes are ready.</div>
        <div style={{marginTop: 7, color: COLORS.muted, fontSize: 14}}>The work came back. The context did not.</div>
        <div style={{marginTop: 17, display: "flex", gap: 22, color: COLORS.muted, fontSize: 13}}>
          <span><b style={{color: COLORS.green}}>✓</b> build passes</span>
          <span><b style={{color: COLORS.green}}>✓</b> result returned</span>
        </div>
      </Panel>
      <Arrow left={429} top={111} width={75} color={COLORS.green} />
      <Panel style={{position: "absolute", left: 530, top: 0, width: 606, height: 238, padding: 22, ...lift(frame, 22)}} accent={COLORS.host}>
        <Tag color={COLORS.host} soft={COLORS.hostSoft}>OPEN QUESTIONS</Tag>
        <div style={{marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12}}>
          {questions.map((question, index) => (
            <div key={question} style={{minHeight: 105, padding: 14, border: `1px solid ${COLORS.lineSoft}`, borderRadius: 9, color: COLORS.ink, fontSize: 16, lineHeight: 1.2, ...lift(frame, 33 + index * 10)}}>
              <div style={{color: COLORS.host, fontSize: 22, fontWeight: 700}}>?</div>
              <div style={{marginTop: 13}}>{question}</div>
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}

function ScopeStage({frame}: {frame: number}) {
  const scopes = [
    ["FULL THREAD", "all messages", COLORS.explainer, COLORS.explainerSoft],
    ["ONE MESSAGE", "one moment", COLORS.purple, COLORS.purpleSoft],
    ["SELECTED PASSAGE", "just this slice", COLORS.green, COLORS.greenSoft],
  ] as const;
  return (
    <>
      <Panel style={{position: "absolute", left: 0, top: 23, width: 300, height: 144, padding: 22, ...lift(frame, 8)}} accent={COLORS.explainer}>
        <div style={{...labelStyle, color: COLORS.explainer}}>YOUR REQUEST</div>
        <div style={{marginTop: 18, color: COLORS.ink, fontSize: 22, fontWeight: 700}}>Explain this agent run.</div>
      </Panel>
      <Arrow left={326} top={83} width={68} />
      <div style={{position: "absolute", left: 420, top: 0, width: 716}}>
        <div style={{...labelStyle, color: COLORS.faint, ...lift(frame, 14)}}>CHOOSE THE SMALLEST USEFUL SCOPE</div>
        <div style={{display: "flex", gap: 13, marginTop: 14}}>
          {scopes.map(([name, detail, color, soft], index) => (
            <Panel key={name} style={{width: 218, height: 171, padding: 18, backgroundColor: index === 0 ? "#17334d" : COLORS.panel, ...lift(frame, 23 + index * 10)}} accent={color}>
              <Tag color={color} soft={soft}>{index === 0 ? "START HERE" : "OPTION"}</Tag>
              <div style={{marginTop: 19, color: COLORS.ink, fontSize: 15, fontWeight: 780, lineHeight: 1.15}}>{name}</div>
              <div style={{marginTop: 9, color: COLORS.muted, fontSize: 13}}>{detail}</div>
            </Panel>
          ))}
        </div>
      </div>
      <div style={{position: "absolute", left: 0, top: 211, width: 1064, height: 42, display: "flex", alignItems: "center", gap: 15, padding: "0 18px", boxSizing: "border-box", borderTop: `1px solid ${COLORS.lineSoft}`, borderBottom: `1px solid ${COLORS.lineSoft}`, ...lift(frame, 44)}}>
        <span style={{...labelStyle, color: COLORS.explainer}}>ASK</span><span style={{color: COLORS.line, fontSize: 20}}>→</span><span style={{...labelStyle, color: COLORS.purple}}>SCOPE</span><span style={{color: COLORS.line, fontSize: 20}}>→</span><span style={{...labelStyle, color: COLORS.green}}>RIGHT CONTEXT</span>
        <span style={{marginLeft: "auto", color: COLORS.muted, fontSize: 13}}>less context, more signal</span>
      </div>
    </>
  );
}

function SnapshotStage({frame}: {frame: number}) {
  const rows = ["request comprehension", "plan and inspect", "return source files", "write the result", "return the artifact"];
  return (
    <>
      <Panel style={{position: "absolute", left: 0, top: 0, width: 605, height: 252, padding: 19, ...lift(frame, 7)}}>
        <div style={{display: "flex", justifyContent: "space-between", ...labelStyle}}><span>THREAD TIMELINE</span><span style={{color: COLORS.explainer}}>LIVE THREAD</span></div>
        <div style={{position: "relative", marginTop: 11}}>
          <div style={{position: "absolute", left: 16, top: 17, bottom: 14, width: 2, backgroundColor: COLORS.line}} />
          <div style={{position: "absolute", left: 3, top: 37, width: 559, height: 119, border: `2px solid ${COLORS.explainer}`, borderRadius: 10, backgroundColor: `${COLORS.explainer}0d`, opacity: reveal(frame, 23)}} />
          <div style={{position: "absolute", left: 21, top: 27, padding: "0 7px", backgroundColor: COLORS.panel, color: COLORS.explainer, fontSize: 9, fontWeight: 850, letterSpacing: 1.1, ...lift(frame, 30)}}>CAPTURED HERE</div>
          {rows.map((row, index) => {
            const selected = index > 0 && index < 4;
            return <div key={row} style={{position: "relative", display: "flex", alignItems: "center", gap: 14, height: 42, ...lift(frame, 15 + index * 8)}}><span style={{width: 20, height: 20, borderRadius: "50%", backgroundColor: selected ? COLORS.explainer : COLORS.backgroundRaised, border: `2px solid ${selected ? COLORS.explainer : COLORS.line}`}} /><span style={{color: selected ? COLORS.ink : COLORS.muted, fontSize: 14}}>{row}</span></div>;
          })}
        </div>
      </Panel>
      <Arrow left={631} top={112} width={58} />
      <Panel style={{position: "absolute", left: 710, top: 0, width: 426, height: 252, padding: 20, ...lift(frame, 18)}} accent={COLORS.explainer}>
        <Tag color={COLORS.explainer} soft={COLORS.explainerSoft}>THREAD SNAPSHOT</Tag>
        <div style={{marginTop: 15, color: COLORS.ink, fontSize: 21, fontWeight: 720}}>Captured for this report</div>
        <div style={{marginTop: 14, borderTop: `1px solid ${COLORS.lineSoft}`}}>
          {[["matching rows", "03"], ["source cap", "180,000 chars"], ["sequence", "preserved"], ["status", "immutable"]].map(([label, value], index) => <div key={label} style={{display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: `1px solid ${COLORS.lineSoft}`, fontSize: 13, ...lift(frame, 31 + index * 8)}}><span style={{color: COLORS.muted}}>{label}</span><b style={{color: index === 3 ? COLORS.green : COLORS.ink}}>{value}</b></div>)}
        </div>
        <div style={{marginTop: 11, color: COLORS.faint, fontSize: 12}}>Same input in. Same explanation out.</div>
      </Panel>
    </>
  );
}

function WorkerStage({frame}: {frame: number}) {
  return (
    <>
      <Panel style={{position: "absolute", left: 0, top: 0, width: 300, height: 252, padding: 20, ...lift(frame, 8)}} accent={COLORS.explainer}>
        <div style={{...labelStyle, color: COLORS.explainer}}>INPUTS</div>
        <div style={{marginTop: 14, display: "grid", gap: 11}}>
          <div style={{padding: 15, borderRadius: 9, backgroundColor: COLORS.explainerSoft, color: COLORS.explainer}}><b style={{fontSize: 13}}>SOURCE SNAPSHOT</b><div style={{marginTop: 7, color: COLORS.muted, fontSize: 13}}>the bounded conversation</div></div>
          <div style={{padding: 15, borderRadius: 9, backgroundColor: COLORS.purpleSoft, color: COLORS.purple}}><b style={{fontSize: 13}}>REPORT SKILL</b><div style={{marginTop: 7, color: COLORS.muted, fontSize: 13}}>the writing instructions</div></div>
        </div>
        <div style={{marginTop: 14, color: COLORS.faint, fontSize: 12}}>plus Quiet Newsroom</div>
      </Panel>
      <Arrow left={326} top={112} width={70} />
      <Panel style={{position: "absolute", left: 420, top: 0, width: 296, height: 252, padding: 20, ...lift(frame, 22)}} accent={COLORS.purple}>
        <div style={{...labelStyle, color: COLORS.purple}}>HIDDEN CHILD THREAD</div>
        <div style={{display: "flex", justifyContent: "center", marginTop: 25}}><div style={{width: 112, height: 112, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", borderRadius: "50%", backgroundColor: COLORS.purpleSoft, border: `2px solid ${COLORS.purple}`, color: COLORS.ink, fontSize: 17, lineHeight: 1.1, fontWeight: 750}}>reads<br />reasons<br />writes</div></div>
        <div style={{marginTop: 17, textAlign: "center", color: COLORS.muted, fontSize: 13}}>out of sight, on purpose</div>
      </Panel>
      <Arrow left={742} top={112} width={70} color={COLORS.green} />
      <Panel style={{position: "absolute", left: 836, top: 0, width: 300, height: 252, padding: 20, ...lift(frame, 36)}} accent={COLORS.green}>
        <div style={{...labelStyle, color: COLORS.green}}>OUTPUT</div>
        <div style={{marginTop: 15, color: COLORS.ink, fontSize: 21, fontWeight: 720}}>One H T M L report</div>
        <div style={{marginTop: 18, padding: 15, borderRadius: 9, backgroundColor: COLORS.greenSoft, color: COLORS.green, fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 16}}>report.html<div style={{marginTop: 11, display: "grid", gap: 7}}><div style={{height: 5, width: "85%", borderRadius: 4, backgroundColor: `${COLORS.green}99`}} /><div style={{height: 5, width: "66%", borderRadius: 4, backgroundColor: `${COLORS.green}66`}} /><div style={{height: 5, width: "75%", borderRadius: 4, backgroundColor: `${COLORS.green}44`}} /></div></div>
        <div style={{marginTop: 15, color: COLORS.muted, fontSize: 13}}>A standalone explanation you can reopen.</div>
      </Panel>
    </>
  );
}

function ReportStage({frame}: {frame: number}) {
  return (
    <>
      <Panel style={{position: "absolute", left: 0, top: 0, width: 790, height: 252, overflow: "hidden", ...lift(frame, 8)}}>
        <div style={{height: 31, display: "flex", alignItems: "center", gap: 7, padding: "0 15px", backgroundColor: COLORS.panelRaised, borderBottom: `1px solid ${COLORS.line}`}}><span style={{width: 7, height: 7, borderRadius: "50%", backgroundColor: COLORS.coral}} /><span style={{width: 7, height: 7, borderRadius: "50%", backgroundColor: COLORS.host}} /><span style={{width: 7, height: 7, borderRadius: "50%", backgroundColor: COLORS.green}} /><span style={{marginLeft: 9, fontFamily: "ui-monospace, SFMono-Regular, monospace", color: COLORS.faint, fontSize: 11}}>comprehension / report.html</span></div>
        <div style={{display: "flex", height: 221}}>
          <div style={{width: 162, padding: 17, backgroundColor: COLORS.backgroundRaised, borderRight: `1px solid ${COLORS.lineSoft}`}}><div style={{...labelStyle, color: COLORS.explainer}}>CONTENTS</div><div style={{marginTop: 14, display: "grid", gap: 11}}>{["At a glance", "System shape", "Key decisions", "What to do next"].map((item, index) => <div key={item} style={{display: "flex", gap: 7, alignItems: "center", color: index === 0 ? COLORS.ink : COLORS.faint, fontSize: 12, ...lift(frame, 18 + index * 8)}}><span style={{width: 4, height: 4, borderRadius: "50%", backgroundColor: index === 0 ? COLORS.explainer : COLORS.line}} />{item}</div>)}</div></div>
          <div style={{padding: "19px 22px", flex: 1}}><div style={{...labelStyle, color: COLORS.green}}>AT A GLANCE</div><div style={{marginTop: 9, color: COLORS.ink, fontSize: 21, fontWeight: 720}}>What changed in the agent run</div><div style={{marginTop: 6, color: COLORS.muted, fontSize: 12}}>A scan-friendly explanation of the work and its reasoning.</div><div style={{display: "flex", alignItems: "center", gap: 9, marginTop: 17}}>{[["INPUT", COLORS.explainer, COLORS.explainerSoft], ["DECISION", COLORS.purple, COLORS.purpleSoft], ["RESULT", COLORS.green, COLORS.greenSoft]].map(([name, color, soft], index) => <div key={name} style={{display: "flex", alignItems: "center", gap: 9}}><span style={{padding: "8px 10px", borderRadius: 7, backgroundColor: soft, color, fontSize: 11, fontWeight: 800}}>{name}</span>{index < 2 ? <span style={{width: 22, height: 2, backgroundColor: COLORS.line}} /> : null}</div>)}</div><div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 11, marginTop: 20}}>{["bounded source", "visible decisions", "nearby evidence", "named next action"].map((item, index) => <div key={item} style={{color: COLORS.muted, fontSize: 12, ...lift(frame, 34 + index * 8)}}><span style={{color: COLORS.green, fontSize: 15}}>✓</span> {item}</div>)}</div></div>
        </div>
      </Panel>
      <div style={{position: "absolute", left: 835, top: 10, width: 301, ...lift(frame, 22)}}><div style={{...labelStyle, color: COLORS.explainer}}>WHAT YOU CAN DO WITH IT</div><div style={{marginTop: 12, display: "grid", gap: 10}}>{[["SCAN", "find the shape", COLORS.explainer], ["REOPEN", "follow a thread", COLORS.purple], ["EMBED", "share the view", COLORS.green]].map(([name, detail, color], index) => <div key={name} style={{display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 0", borderBottom: `1px solid ${COLORS.lineSoft}`, ...lift(frame, 31 + index * 9)}}><span style={{fontSize: 13, fontWeight: 800, letterSpacing: 1.2, color}}>{name}</span><span style={{color: COLORS.muted, fontSize: 13}}>{detail}</span></div>)}</div></div>
    </>
  );
}

function GapStage({frame}: {frame: number}) {
  const report = ["system shape", "implementation details", "source links"];
  const missing = ["current status", "difficult decisions", "evidence that matters", "next action"];
  return (
    <>
      <Panel style={{position: "absolute", left: 0, top: 0, width: 475, height: 252, padding: 21, ...lift(frame, 8)}} accent={COLORS.explainer}>
        <Tag color={COLORS.explainer} soft={COLORS.explainerSoft}>REPORT</Tag>
        <div style={{marginTop: 16, color: COLORS.ink, fontSize: 20, fontWeight: 720}}>Explains the shape</div>
        <div style={{marginTop: 14, borderTop: `1px solid ${COLORS.lineSoft}`}}>{report.map((item, index) => <div key={item} style={{padding: "12px 0", borderBottom: `1px solid ${COLORS.lineSoft}`, color: COLORS.muted, fontSize: 14, ...lift(frame, 23 + index * 10)}}><span style={{color: COLORS.explainer}}>●</span> {item}</div>)}</div>
      </Panel>
      <div style={{position: "absolute", left: 500, top: 88, width: 135, textAlign: "center", ...lift(frame, 29)}}><div style={{color: COLORS.host, fontSize: 30}}>≠</div><div style={{marginTop: 5, color: COLORS.faint, fontSize: 10, fontWeight: 800, letterSpacing: 1.3}}>TIME + STATE</div></div>
      <Panel style={{position: "absolute", left: 661, top: 0, width: 475, height: 252, padding: 21, ...lift(frame, 20)}} accent={COLORS.host}>
        <Tag color={COLORS.host} soft={COLORS.hostSoft}>BRIEFING</Tag>
        <div style={{marginTop: 16, color: COLORS.ink, fontSize: 20, fontWeight: 720}}>Still needed when you step back in</div>
        <div style={{marginTop: 14, borderTop: `1px solid ${COLORS.lineSoft}`}}>{missing.map((item, index) => <div key={item} style={{padding: "9px 0", borderBottom: `1px solid ${COLORS.lineSoft}`, color: COLORS.muted, fontSize: 14, ...lift(frame, 31 + index * 9)}}><span style={{color: COLORS.host}}>?</span> {item}</div>)}</div>
      </Panel>
    </>
  );
}

function BriefStage({frame}: {frame: number}) {
  const moments = [["STATUS", "what matters now", COLORS.explainer], ["CONTEXT", "where we are", COLORS.purple], ["CHANGE", "what moved", COLORS.host], ["EVIDENCE", "why believe it", COLORS.green], ["NEXT", "what to do", COLORS.coral]] as const;
  const views = [["H T M L", COLORS.explainer], ["PLAYER", COLORS.purple], ["SLIDES", COLORS.host], ["VIDEO", COLORS.green]] as const;
  return (
    <>
      <div style={{position: "absolute", left: 35, top: 10, width: 1030, ...lift(frame, 8)}}><div style={{position: "absolute", left: 46, right: 46, top: 17, height: 2, backgroundColor: COLORS.line}} />{moments.map(([name, detail, color], index) => <div key={name} style={{position: "absolute", left: index * 235, top: 0, width: 170, textAlign: "center"}}><div style={{margin: "0 auto", width: 18, height: 18, borderRadius: "50%", backgroundColor: COLORS.background, border: `3px solid ${color}`}} /><div style={{marginTop: 12, color, fontSize: 11, fontWeight: 850, letterSpacing: 1.2}}>{name}</div><div style={{marginTop: 5, color: COLORS.muted, fontSize: 12}}>{detail}</div></div>)}</div>
      <Panel style={{position: "absolute", left: 0, top: 142, width: 260, height: 100, padding: 18, ...lift(frame, 33)}} accent={COLORS.explainer}><div style={{...labelStyle, color: COLORS.explainer}}>ONE BRIEF</div><div style={{marginTop: 10, color: COLORS.ink, fontSize: 18, fontWeight: 720}}>A current story of the work</div></Panel>
      <Arrow left={285} top={180} width={50} />
      <div style={{position: "absolute", left: 360, top: 142, display: "flex", gap: 12}}>{views.map(([view, color], index) => <div key={view} style={{width: 145, height: 100, padding: 16, boxSizing: "border-box", border: `1px solid ${color}88`, borderRadius: 11, backgroundColor: COLORS.panel, ...lift(frame, 45 + index * 9)}}><div style={{color, fontSize: 13, fontWeight: 850, letterSpacing: 1.1}}>{view}</div><div style={{marginTop: 13, display: "grid", gap: 6}}><div style={{height: 4, width: "84%", borderRadius: 3, backgroundColor: COLORS.line}} /><div style={{height: 4, width: "64%", borderRadius: 3, backgroundColor: COLORS.lineSoft}} /><div style={{height: 4, width: "73%", borderRadius: 3, backgroundColor: COLORS.lineSoft}} /></div></div>)}</div>
      <div style={{position: "absolute", left: 329, top: 257, color: COLORS.ink, fontSize: 15, fontWeight: 650, ...lift(frame, 75)}}>one source of truth → many ways to understand it</div>
    </>
  );
}

function EvidenceStage({chapterIndex, frame}: {chapterIndex: number; frame: number}) {
  const stages = [HandoffStage, ScopeStage, SnapshotStage, WorkerStage, ReportStage, GapStage, BriefStage];
  const Stage = stages[chapterIndex];
  return <Stage frame={frame} />;
}

function getChapterIndex(frame: number) {
  const index = CHAPTERS.findIndex((chapter) => frame >= chapter.start && frame < chapter.end);
  return index === -1 ? CHAPTERS.length - 1 : index;
}

function Background() {
  return (
    <AbsoluteFill style={{backgroundColor: COLORS.background, fontFamily: FONT_FAMILY, color: COLORS.ink}}>
      <div style={{position: "absolute", inset: 0, opacity: 0.15, backgroundImage: "linear-gradient(rgba(130, 170, 205, 0.15) 1px, transparent 1px)", backgroundSize: "100% 48px"}} />
      <div style={{position: "absolute", left: 72, right: 72, top: 102, height: 1, backgroundColor: COLORS.lineSoft}} />
    </AbsoluteFill>
  );
}

function Header({frame, chapterIndex}: {frame: number; chapterIndex: number}) {
  const seconds = Math.floor(frame / FPS);
  const time = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <>
      <div style={{position: "absolute", left: 72, top: 24, zIndex: 10, display: "flex", alignItems: "center", gap: 12}}><div style={{width: 11, height: 11, borderRadius: 3, backgroundColor: COLORS.explainer}} /><div style={{fontSize: 13, fontWeight: 850, letterSpacing: 2.1}}>COMPREHENSION</div><div style={{color: COLORS.faint, fontSize: 11, letterSpacing: 1.2}}>THE HANDOFF CONVERSATION</div></div>
      <div style={{position: "absolute", right: 72, top: 23, zIndex: 10, color: COLORS.faint, fontSize: 11, letterSpacing: 1.3}}>PODCAST STUDY · {time}</div>
      <div style={{position: "absolute", left: 72, right: 72, top: 69, height: 20, zIndex: 10, display: "flex", gap: 10}}>{CHAPTERS.map((chapter, index) => <div key={chapter.label} style={{flex: 1, position: "relative", opacity: index === chapterIndex ? 1 : 0.42}}><div style={{height: 3, backgroundColor: index === chapterIndex ? COLORS.explainer : COLORS.line, borderRadius: 2}} />{index === chapterIndex ? <div style={{position: "absolute", top: 9, left: 0, color: COLORS.explainer, fontSize: 9, fontWeight: 850, letterSpacing: 1.1}}>{chapter.label}</div> : null}</div>)}</div>
    </>
  );
}

function SpeakerBand({activeRole}: {activeRole: Role | null}) {
  const speakers = [
    {role: "HOST" as const, name: "RETURNING ENGINEER", color: COLORS.host, soft: COLORS.hostSoft, state: activeRole === "HOST" ? "ASKING" : "LISTENING"},
    {role: "EXPLAINER" as const, name: "COMPREHENSION", color: COLORS.explainer, soft: COLORS.explainerSoft, state: activeRole === "EXPLAINER" ? "RESPONDING" : "LISTENING"},
  ];
  return (
    <div style={{position: "absolute", left: 72, right: 72, top: 112, height: 48, zIndex: 10, display: "grid", gridTemplateColumns: "1fr 1fr", border: `1px solid ${COLORS.line}`, borderRadius: 10, overflow: "hidden"}}>
      {speakers.map(({role, name, color, soft, state}, index) => <div key={role} style={{display: "flex", alignItems: "center", gap: 12, padding: "0 17px", backgroundColor: activeRole === role ? soft : COLORS.backgroundRaised, borderRight: index === 0 ? `1px solid ${COLORS.line}` : "none"}}><div style={{width: 10, height: 10, borderRadius: "50%", backgroundColor: color, boxShadow: activeRole === role ? `0 0 15px ${color}` : "none"}} /><span style={{color, fontSize: 11, fontWeight: 850, letterSpacing: 1.35}}>{role}</span><span style={{color: COLORS.muted, fontSize: 12}}>{name}</span><span style={{marginLeft: "auto", color: activeRole === role ? color : COLORS.faint, fontSize: 10, fontWeight: 800, letterSpacing: 1.1}}>{state}</span></div>)}
    </div>
  );
}

function Waveform({frame, color}: {frame: number; color: string}) {
  return <div style={{display: "flex", alignItems: "center", gap: 3, height: 24}}>{Array.from({length: 18}, (_, index) => {const height = 5 + Math.abs(Math.sin(frame * 0.13 + index * 1.8)) * 15; return <div key={index} style={{width: 3, height, borderRadius: 3, backgroundColor: color, opacity: 0.55 + (index % 3) * 0.13}} />;})}</div>;
}

function Captions({frame, cue}: {frame: number; cue: CaptionCue | undefined}) {
  const color = cue?.role === "HOST" ? COLORS.host : COLORS.explainer;
  const soft = cue?.role === "HOST" ? COLORS.hostSoft : COLORS.explainerSoft;
  const cueFrame = cue ? frame - cue.start : 0;
  const cueDuration = cue ? cue.end - cue.start : 1;
  const fadeIn = cue ? interpolate(cueFrame, [0, 8], [0, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"}) : 0;
  const fadeOut = cue ? interpolate(cueDuration - cueFrame, [0, 10], [0, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"}) : 0;
  return (
    <div style={{position: "absolute", left: 72, right: 72, top: 570, height: 103, zIndex: 20, display: "flex", alignItems: "center", gap: 18, padding: "0 20px", boxSizing: "border-box", borderTop: `1px solid ${cue ? color : COLORS.line}`, borderBottom: `1px solid ${COLORS.lineSoft}`, backgroundColor: COLORS.backgroundRaised}}>
      <div style={{width: 104, flexShrink: 0, alignSelf: "stretch", display: "flex", flexDirection: "column", justifyContent: "center", gap: 8, borderRight: `1px solid ${COLORS.lineSoft}`}}><Tag color={color} soft={soft}>{cue?.role ?? "PAUSE"}</Tag>{cue ? <Waveform frame={frame} color={color} /> : null}</div>
      <div style={{opacity: cue ? fadeIn * fadeOut : 0.35, color: COLORS.ink, fontSize: 19, lineHeight: 1.26, fontWeight: 540, maxHeight: 96, overflow: "hidden"}}>{cue?.text ?? ""}</div>
      <div style={{marginLeft: "auto", alignSelf: "flex-end", paddingBottom: 15, color: COLORS.faint, fontSize: 10, letterSpacing: 1.1}}>CLOSED CAPTIONS</div>
    </div>
  );
}

export const ComprehensionPodcast = () => {
  const frame = useCurrentFrame();
  const chapterIndex = getChapterIndex(frame);
  const chapter = CHAPTERS[chapterIndex];
  const cue = CUES.find((candidate) => frame >= candidate.start && frame < candidate.end);
  return (
    <AbsoluteFill style={{fontFamily: FONT_FAMILY}}>
      <Background />
      <Header frame={frame} chapterIndex={chapterIndex} />
      <SpeakerBand activeRole={cue?.role ?? null} />
      <StageFrame chapter={chapter} frame={frame - chapter.start}>
        <EvidenceStage chapterIndex={chapterIndex} frame={frame - chapter.start} />
      </StageFrame>
      <Captions frame={frame} cue={cue} />
      <Audio src={staticFile("podcast.wav")} volume={0.95} />
    </AbsoluteFill>
  );
};
