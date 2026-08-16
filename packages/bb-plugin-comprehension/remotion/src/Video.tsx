import {Audio} from "@remotion/media";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
} from "remotion";
import type {CSSProperties, ReactNode} from "react";

export const FPS = 30;
export const WIDTH = 1280;
export const HEIGHT = 720;
const SCENE_DURATIONS = [315, 270, 380, 450, 430, 340, 335] as const;
const SCENE_STARTS = SCENE_DURATIONS.map((_, index) =>
  SCENE_DURATIONS.slice(0, index).reduce((total, duration) => total + duration, 0),
);
export const DURATION_IN_FRAMES = SCENE_DURATIONS.reduce((total, duration) => total + duration, 0);

const FONT_FAMILY =
  "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif";

const COLORS = {
  background: "#09111f",
  backgroundMid: "#0d1a2b",
  panel: "#122137",
  panelRaised: "#172b45",
  panelSoft: "#102039",
  line: "#2a4564",
  lineSoft: "#203650",
  ink: "#eef6ff",
  muted: "#9eb1c8",
  faint: "#7187a1",
  cyan: "#61d7ef",
  cyanSoft: "#193e55",
  green: "#83e3ae",
  greenSoft: "#173f38",
  yellow: "#f4c875",
  yellowSoft: "#4a3a20",
  coral: "#ff9b8f",
  coralSoft: "#4c2a31",
  purple: "#b6a7ff",
  purpleSoft: "#302b5d",
};

const CHAPTERS = [
  "THE HANDOFF",
  "THE QUESTION",
  "THE SNAPSHOT",
  "THE WORKER",
  "THE REPORT",
  "THE GAP",
  "THE BRIEF",
];

type CaptionCue = {
  start: number;
  end: number;
  text: string;
};

const CAPTION_CUES: CaptionCue[] = [
  {
    start: 0,
    end: 175,
    text: "An agent can finish the work and still leave you with a comprehension problem.",
  },
  {
    start: 175,
    end: 315,
    text: "What changed? Why did it change? What needs your attention?",
  },
  {
    start: 315,
    end: 405,
    text: "Comprehension starts with one question.",
  },
  {
    start: 405,
    end: 585,
    text: "Do you want the whole thread, one message, or a selected passage? That choice defines the context.",
  },
  {
    start: 585,
    end: 635,
    text: "The server freezes that context.",
  },
  {
    start: 635,
    end: 845,
    text: "It keeps the matching thread rows, caps the source, and records the exact point in the conversation.",
  },
  {
    start: 845,
    end: 965,
    text: "This is a snapshot, not a live feed.",
  },
  {
    start: 965,
    end: 1135,
    text: "A hidden child thread receives the report skill and Quiet Newsroom template.",
  },
  {
    start: 1135,
    end: 1285,
    text: "It turns the snapshot into one H T M L document.",
  },
  {
    start: 1285,
    end: 1415,
    text: "The worker writes out of sight, so the explanation does not interrupt you.",
  },
  {
    start: 1415,
    end: 1535,
    text: "The report comes back as a reusable view.",
  },
  {
    start: 1535,
    end: 1665,
    text: "It gives you a starting point, a table of contents, open sections, and diagrams.",
  },
  {
    start: 1665,
    end: 1845,
    text: "You can read it, reopen it, or embed it in the thread.",
  },
  {
    start: 1845,
    end: 1965,
    text: "But a finished report is not the same as a current briefing.",
  },
  {
    start: 1965,
    end: 2185,
    text: "It does not yet show what changed, which decisions were difficult, or what evidence matters.",
  },
  {
    start: 2185,
    end: 2285,
    text: "That is the temporal brief: status, context, change, evidence, and next action.",
  },
  {
    start: 2285,
    end: 2520,
    text: "One brief can become H T M L, narrated slides, a player, or a video.",
  },
];

const basePanel: CSSProperties = {
  backgroundColor: COLORS.panel,
  border: `1px solid ${COLORS.line}`,
  borderRadius: 18,
  boxShadow: "0 18px 50px rgba(0, 0, 0, 0.18)",
};

const labelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: 1.8,
  color: COLORS.faint,
};

const smallTextStyle: CSSProperties = {
  fontSize: 15,
  lineHeight: 1.45,
  color: COLORS.muted,
};

function reveal(frame: number, delay = 0, duration = 24) {
  return interpolate(frame, [delay, delay + duration], [0, 1], {
    easing: Easing.out(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

function lift(frame: number, delay = 0, distance = 18): CSSProperties {
  const progress = reveal(frame, delay);
  return {
    opacity: progress,
    transform: `translateY(${(1 - progress) * distance}px)`,
  };
}

function drift(frame: number, delay = 0, distance = 22): CSSProperties {
  const progress = reveal(frame, delay);
  return {
    opacity: progress,
    transform: `translateX(${(1 - progress) * distance}px)`,
  };
}

function pulse(frame: number, delay = 0) {
  const progress = reveal(frame, delay, 30);
  return {
    opacity: progress,
    transform: `scale(${0.94 + progress * 0.06})`,
  };
}

function Panel({
  children,
  style,
  accent,
}: {
  children: ReactNode;
  style?: CSSProperties;
  accent?: string;
}) {
  return (
    <div
      style={{
        ...basePanel,
        ...(accent ? {borderColor: accent} : {}),
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Tag({
  children,
  color = COLORS.cyan,
  soft = COLORS.cyanSoft,
}: {
  children: ReactNode;
  color?: string;
  soft?: string;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: "7px 10px",
        borderRadius: 999,
        backgroundColor: soft,
        color,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: 1.4,
        lineHeight: 1,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          backgroundColor: color,
          boxShadow: `0 0 12px ${color}`,
        }}
      />
      {children}
    </span>
  );
}

function FlowArrow({
  left,
  top,
  width = 88,
  color = COLORS.cyan,
}: {
  left: number;
  top: number;
  width?: number;
  color?: string;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        width,
        height: 30,
        color,
        display: "flex",
        alignItems: "center",
      }}
    >
      <div
        style={{
          height: 2,
          flex: 1,
          backgroundColor: color,
          opacity: 0.8,
        }}
      />
      <div
        style={{
          width: 0,
          height: 0,
          borderTop: "6px solid transparent",
          borderBottom: "6px solid transparent",
          borderLeft: `9px solid ${color}`,
        }}
      />
    </div>
  );
}

function CheckRow({children, color = COLORS.green}: {children: ReactNode; color?: string}) {
  return (
    <div style={{display: "flex", alignItems: "center", gap: 10, marginTop: 13}}>
      <span
        style={{
          display: "inline-flex",
          width: 19,
          height: 19,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 6,
          backgroundColor: `${color}22`,
          color,
          fontSize: 13,
          fontWeight: 900,
        }}
      >
        ✓
      </span>
      <span style={{fontSize: 15, color: COLORS.muted}}>{children}</span>
    </div>
  );
}

function SceneHeading({
  index,
  title,
  subtitle,
}: {
  index: number;
  title: string;
  subtitle: string;
}) {
  const frame = useCurrentFrame();
  return (
    <div style={{position: "absolute", left: 72, top: 88, width: 820, ...lift(frame)}}>
      <div style={{...labelStyle, color: COLORS.cyan}}>
        CHAPTER {String(index + 1).padStart(2, "0")} / 07
      </div>
      <div
        style={{
          marginTop: 11,
          color: COLORS.ink,
          fontSize: 39,
          fontWeight: 760,
          letterSpacing: -1.2,
          lineHeight: 1.05,
        }}
      >
        {title}
      </div>
      <div
        style={{
          marginTop: 10,
          color: COLORS.muted,
          fontSize: 18,
          lineHeight: 1.35,
          maxWidth: 760,
        }}
      >
        {subtitle}
      </div>
    </div>
  );
}

function SceneFrame({
  index,
  title,
  subtitle,
  children,
}: {
  index: number;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <AbsoluteFill>
      <SceneHeading index={index} title={title} subtitle={subtitle} />
      <div
        style={{
          position: "absolute",
          left: 72,
          top: 198,
          width: WIDTH - 144,
          height: 365,
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
}

function SceneOne() {
  const frame = useCurrentFrame();
  const questions = ["What changed?", "Why this approach?", "What needs my attention?"];

  return (
    <SceneFrame
      index={0}
      title="The handoff problem"
      subtitle="An agent can finish the work and still leave you behind."
    >
      <Panel style={{position: "absolute", left: 0, top: 32, width: 352, height: 284, padding: 26, ...lift(frame, 4)}} accent={COLORS.green}>
        <Tag color={COLORS.green} soft={COLORS.greenSoft}>
          AGENT FINISHED
        </Tag>
        <div style={{marginTop: 25, fontSize: 28, fontWeight: 720, color: COLORS.ink}}>
          Changes are ready.
        </div>
        <div style={{marginTop: 8, ...smallTextStyle}}>The work came back. The context did not.</div>
        <div style={{marginTop: 18}}>
          <CheckRow>build passes</CheckRow>
          <CheckRow>files changed</CheckRow>
          <CheckRow>result returned</CheckRow>
        </div>
      </Panel>

      <FlowArrow left={376} top={171} width={100} color={COLORS.green} />

      <Panel
        style={{
          position: "absolute",
          left: 500,
          top: 4,
          width: 560,
          height: 340,
          padding: 28,
          ...drift(frame, 16),
        }}
        accent={COLORS.yellow}
      >
        <Tag color={COLORS.yellow} soft={COLORS.yellowSoft}>
          YOUR OPEN QUESTIONS
        </Tag>
        <div style={{marginTop: 20, color: COLORS.ink, fontSize: 22, fontWeight: 650}}>
          A completed task is not yet a useful handoff.
        </div>
        <div style={{marginTop: 18}}>
          {questions.map((question, index) => (
            <div
              key={question}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                padding: "14px 0",
                borderTop: `1px solid ${COLORS.lineSoft}`,
                color: COLORS.ink,
                fontSize: 21,
                ...lift(frame, 32 + index * 12),
              }}
            >
              <span
                style={{
                  display: "inline-flex",
                  width: 28,
                  height: 28,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 9,
                  backgroundColor: COLORS.yellowSoft,
                  color: COLORS.yellow,
                  fontSize: 17,
                  fontWeight: 800,
                }}
              >
                ?
              </span>
              {question}
            </div>
          ))}
        </div>
      </Panel>

      <div
        style={{
          position: "absolute",
          left: 384,
          top: 300,
          color: COLORS.faint,
          fontSize: 13,
          letterSpacing: 1.1,
          textTransform: "uppercase",
          ...lift(frame, 55),
        }}
      >
        comprehension is the missing handoff layer
      </div>
    </SceneFrame>
  );
}

function SceneTwo() {
  const frame = useCurrentFrame();
  const scopes = [
    {name: "FULL THREAD", detail: "all messages", color: COLORS.cyan, soft: COLORS.cyanSoft},
    {name: "ONE MESSAGE", detail: "one moment", color: COLORS.purple, soft: COLORS.purpleSoft},
    {name: "SELECTED PASSAGE", detail: "just this slice", color: COLORS.green, soft: COLORS.greenSoft},
  ];

  return (
    <SceneFrame
      index={1}
      title="Start with the question"
      subtitle="Your starting point determines the context that gets explained."
    >
      <Panel style={{position: "absolute", left: 0, top: 45, width: 318, height: 144, padding: 25, ...lift(frame, 4)}} accent={COLORS.cyan}>
        <div style={{...labelStyle, color: COLORS.cyan}}>YOUR REQUEST</div>
        <div style={{marginTop: 20, fontSize: 25, fontWeight: 700, color: COLORS.ink}}>
          Explain this agent run.
        </div>
      </Panel>

      <FlowArrow left={338} top={104} width={92} />

      <div style={{position: "absolute", left: 458, top: 0, width: 650}}>
        <div style={{...labelStyle, color: COLORS.faint, ...lift(frame, 12)}}>
          CHOOSE THE SMALLEST USEFUL SCOPE
        </div>
        <div style={{display: "flex", gap: 16, marginTop: 17}}>
          {scopes.map((scope, index) => (
            <Panel
              key={scope.name}
              style={{
                width: 204,
                height: 170,
                padding: 20,
                backgroundColor: index === 0 ? "#15314b" : COLORS.panel,
                ...lift(frame, 22 + index * 12),
              }}
              accent={scope.color}
            >
              <Tag color={scope.color} soft={scope.soft}>
                {index === 0 ? "EXAMPLE" : "OPTION"}
              </Tag>
              <div style={{marginTop: 22, color: COLORS.ink, fontSize: 17, fontWeight: 750, lineHeight: 1.15}}>
                {scope.name}
              </div>
              <div style={{marginTop: 10, ...smallTextStyle}}>{scope.detail}</div>
            </Panel>
          ))}
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          left: 0,
          top: 245,
          width: 1062,
          height: 70,
          display: "flex",
          alignItems: "center",
          padding: "0 24px",
          borderRadius: 14,
          backgroundColor: COLORS.panelSoft,
          border: `1px solid ${COLORS.lineSoft}`,
          ...lift(frame, 55),
        }}
      >
        <span style={{...labelStyle, color: COLORS.cyan}}>ASK</span>
        <span style={{margin: "0 18px", color: COLORS.line, fontSize: 24}}>→</span>
        <span style={{...labelStyle, color: COLORS.purple}}>SCOPE</span>
        <span style={{margin: "0 18px", color: COLORS.line, fontSize: 24}}>→</span>
        <span style={{...labelStyle, color: COLORS.green}}>CAPTURE THE RIGHT SLICE</span>
        <span style={{marginLeft: "auto", color: COLORS.muted, fontSize: 15}}>
          less context, more signal
        </span>
      </div>
    </SceneFrame>
  );
}

function SceneThree() {
  const frame = useCurrentFrame();
  const rows = [
    ["USER", "request comprehension"],
    ["AGENT", "plan and inspect"],
    ["TOOL", "return source files"],
    ["AGENT", "write the result"],
    ["SYSTEM", "return the artifact"],
  ];

  return (
    <SceneFrame
      index={2}
      title="Freeze the context"
      subtitle="The report is built from a bounded snapshot, not a live feed."
    >
      <Panel style={{position: "absolute", left: 0, top: 16, width: 598, height: 332, padding: 22, ...lift(frame, 4)}}>
        <div style={{display: "flex", alignItems: "center", justifyContent: "space-between"}}>
          <div style={{...labelStyle, color: COLORS.faint}}>THREAD TIMELINE</div>
          <div style={{fontSize: 12, color: COLORS.cyan, letterSpacing: 1.2, fontWeight: 750}}>LIVE THREAD</div>
        </div>
        <div style={{position: "relative", marginTop: 17}}>
          <div style={{position: "absolute", left: 17, top: 20, bottom: 19, width: 2, backgroundColor: COLORS.line}} />
          <div
            style={{
              position: "absolute",
              left: 3,
              top: 53,
              width: 544,
              height: 133,
              border: `2px solid ${COLORS.cyan}`,
              borderRadius: 12,
              backgroundColor: "rgba(97, 215, 239, 0.08)",
              opacity: reveal(frame, 25),
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 19,
              top: 43,
              color: COLORS.cyan,
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: 1.3,
              backgroundColor: COLORS.panel,
              padding: "0 8px",
              ...lift(frame, 34),
            }}
          >
            CAPTURED HERE
          </div>
          {rows.map(([kind, text], index) => {
            const selected = index >= 1 && index <= 3;
            return (
              <div
                key={`${kind}-${text}`}
                style={{
                  position: "relative",
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  height: 45,
                  ...lift(frame, 18 + index * 9),
                }}
              >
                <div
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: "50%",
                    backgroundColor: selected ? COLORS.cyan : COLORS.backgroundMid,
                    border: `2px solid ${selected ? COLORS.cyan : COLORS.line}`,
                    boxShadow: selected ? `0 0 15px ${COLORS.cyan}55` : "none",
                  }}
                />
                <span style={{...labelStyle, color: selected ? COLORS.cyan : COLORS.faint, width: 70}}>{kind}</span>
                <span style={{fontSize: 16, color: selected ? COLORS.ink : COLORS.muted}}>{text}</span>
              </div>
            );
          })}
        </div>
      </Panel>

      <FlowArrow left={619} top={174} width={60} />

      <Panel style={{position: "absolute", left: 690, top: 16, width: 372, height: 332, padding: 24, ...drift(frame, 18)}} accent={COLORS.cyan}>
        <Tag color={COLORS.cyan} soft={COLORS.cyanSoft}>
          THREAD SNAPSHOT
        </Tag>
        <div style={{marginTop: 20, fontSize: 23, fontWeight: 720, color: COLORS.ink}}>
          Captured for this report
        </div>
        <div style={{marginTop: 19, borderTop: `1px solid ${COLORS.lineSoft}`}}>
          {[
            ["matching rows", "03"],
            ["source cap", "180,000 chars"],
            ["source sequence", "preserved"],
            ["status", "immutable"],
          ].map(([label, value], index) => (
            <div
              key={label}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "13px 0",
                borderBottom: `1px solid ${COLORS.lineSoft}`,
                ...lift(frame, 36 + index * 10),
              }}
            >
              <span style={{fontSize: 15, color: COLORS.muted}}>{label}</span>
              <span style={{fontSize: 15, color: index === 3 ? COLORS.green : COLORS.ink, fontWeight: 700}}>{value}</span>
            </div>
          ))}
        </div>
        <div style={{marginTop: 16, color: COLORS.faint, fontSize: 13}}>Same input in. Same explanation out.</div>
      </Panel>
    </SceneFrame>
  );
}

function SceneFour() {
  const frame = useCurrentFrame();
  return (
    <SceneFrame
      index={3}
      title="A hidden worker writes the explanation"
      subtitle="The system gives the snapshot and instructions to a child thread."
    >
      <Panel style={{position: "absolute", left: 0, top: 22, width: 282, height: 315, padding: 22, ...lift(frame, 4)}} accent={COLORS.cyan}>
        <div style={{...labelStyle, color: COLORS.cyan}}>INPUTS</div>
        <div style={{marginTop: 16, display: "grid", gap: 12}}>
          <div style={{padding: 17, borderRadius: 12, backgroundColor: COLORS.cyanSoft, border: `1px solid ${COLORS.cyan}66`}}>
            <div style={{fontSize: 14, fontWeight: 800, color: COLORS.cyan}}>SOURCE SNAPSHOT</div>
            <div style={{marginTop: 8, ...smallTextStyle}}>the bounded conversation</div>
          </div>
          <div style={{padding: 17, borderRadius: 12, backgroundColor: COLORS.purpleSoft, border: `1px solid ${COLORS.purple}66`}}>
            <div style={{fontSize: 14, fontWeight: 800, color: COLORS.purple}}>REPORT SKILL</div>
            <div style={{marginTop: 8, ...smallTextStyle}}>the writing instructions</div>
          </div>
        </div>
        <div style={{marginTop: 19, color: COLORS.faint, fontSize: 13}}>plus Quiet Newsroom</div>
      </Panel>

      <FlowArrow left={298} top={176} width={84} />

      <Panel style={{position: "absolute", left: 385, top: 22, width: 300, height: 315, padding: 22, ...pulse(frame, 18)}} accent={COLORS.purple}>
        <div style={{...labelStyle, color: COLORS.purple}}>HIDDEN CHILD THREAD</div>
        <div style={{display: "flex", justifyContent: "center", marginTop: 26}}>
          <div
            style={{
              width: 126,
              height: 126,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              textAlign: "center",
              borderRadius: "50%",
              background: `radial-gradient(circle, ${COLORS.purpleSoft}, ${COLORS.panelSoft})`,
              border: `2px solid ${COLORS.purple}`,
              boxShadow: `0 0 34px ${COLORS.purple}33`,
              color: COLORS.ink,
              fontSize: 18,
              lineHeight: 1.1,
              fontWeight: 750,
            }}
          >
            reads
            <br />
            reasons
            <br />
            writes
          </div>
        </div>
        <div style={{marginTop: 22, textAlign: "center", color: COLORS.muted, fontSize: 14}}>out of sight, on purpose</div>
      </Panel>

      <FlowArrow left={701} top={176} width={84} color={COLORS.green} />

      <Panel style={{position: "absolute", left: 786, top: 22, width: 276, height: 315, padding: 22, ...drift(frame, 32)}} accent={COLORS.green}>
        <div style={{...labelStyle, color: COLORS.green}}>OUTPUT</div>
        <div style={{marginTop: 19, color: COLORS.ink, fontSize: 23, fontWeight: 720}}>One H T M L document</div>
        <div style={{marginTop: 21, padding: 15, borderRadius: 12, backgroundColor: COLORS.greenSoft, border: `1px solid ${COLORS.green}66`}}>
          <div style={{fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 17, color: COLORS.green}}>report.html</div>
          <div style={{marginTop: 13, display: "grid", gap: 8}}>
            <div style={{height: 6, width: "86%", borderRadius: 4, backgroundColor: `${COLORS.green}99`}} />
            <div style={{height: 6, width: "68%", borderRadius: 4, backgroundColor: `${COLORS.green}66`}} />
            <div style={{height: 6, width: "76%", borderRadius: 4, backgroundColor: `${COLORS.green}44`}} />
          </div>
        </div>
        <div style={{marginTop: 20, ...smallTextStyle}}>A standalone explanation you can reopen.</div>
      </Panel>
    </SceneFrame>
  );
}

function MiniDiagram() {
  return (
    <div style={{display: "flex", alignItems: "center", gap: 10, marginTop: 17}}>
      <div style={{padding: "10px 13px", borderRadius: 9, backgroundColor: COLORS.cyanSoft, color: COLORS.cyan, fontSize: 12, fontWeight: 750}}>INPUT</div>
      <div style={{height: 2, width: 26, backgroundColor: COLORS.line}} />
      <div style={{padding: "10px 13px", borderRadius: 9, backgroundColor: COLORS.purpleSoft, color: COLORS.purple, fontSize: 12, fontWeight: 750}}>DECISION</div>
      <div style={{height: 2, width: 26, backgroundColor: COLORS.line}} />
      <div style={{padding: "10px 13px", borderRadius: 9, backgroundColor: COLORS.greenSoft, color: COLORS.green, fontSize: 12, fontWeight: 750}}>RESULT</div>
    </div>
  );
}

function SceneFive() {
  const frame = useCurrentFrame();
  const reuse = [
    ["SCAN", "find the shape", COLORS.cyan],
    ["REOPEN", "follow a thread", COLORS.purple],
    ["EMBED", "share the view", COLORS.green],
  ] as const;

  return (
    <SceneFrame
      index={4}
      title="The result is a place to start"
      subtitle="The report is a reusable view, not a wall of raw output."
    >
      <Panel style={{position: "absolute", left: 0, top: 4, width: 824, height: 356, overflow: "hidden", ...lift(frame, 4)}}>
        <div style={{height: 36, display: "flex", alignItems: "center", gap: 8, padding: "0 18px", backgroundColor: COLORS.panelRaised, borderBottom: `1px solid ${COLORS.line}`}}>
          <span style={{width: 8, height: 8, borderRadius: "50%", backgroundColor: COLORS.coral}} />
          <span style={{width: 8, height: 8, borderRadius: "50%", backgroundColor: COLORS.yellow}} />
          <span style={{width: 8, height: 8, borderRadius: "50%", backgroundColor: COLORS.green}} />
          <span style={{marginLeft: 12, fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12, color: COLORS.faint}}>comprehension-plugin / report.html</span>
        </div>
        <div style={{display: "flex", height: 320}}>
          <div style={{width: 184, padding: 22, backgroundColor: COLORS.panelSoft, borderRight: `1px solid ${COLORS.lineSoft}`}}>
            <div style={{...labelStyle, color: COLORS.cyan}}>CONTENTS</div>
            <div style={{marginTop: 19, display: "grid", gap: 15}}>
              {["At a glance", "System shape", "Key decisions", "What to do next"].map((item, index) => (
                <div key={item} style={{display: "flex", gap: 9, alignItems: "center", color: index === 0 ? COLORS.ink : COLORS.faint, fontSize: 13, ...lift(frame, 24 + index * 10)}}>
                  <span style={{width: 5, height: 5, borderRadius: "50%", backgroundColor: index === 0 ? COLORS.cyan : COLORS.line}} />
                  {item}
                </div>
              ))}
            </div>
          </div>
          <div style={{padding: "24px 27px", flex: 1}}>
            <div style={{...labelStyle, color: COLORS.green}}>AT A GLANCE</div>
            <div style={{marginTop: 12, color: COLORS.ink, fontSize: 25, fontWeight: 720}}>What changed in the agent run</div>
            <div style={{marginTop: 8, color: COLORS.muted, fontSize: 14}}>A scan-friendly explanation of the work and its reasoning.</div>
            <MiniDiagram />
            <div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 13, marginTop: 23}}>
              {["one bounded source", "decisions made visible", "evidence close at hand", "next action named"].map((item, index) => (
                <div key={item} style={{display: "flex", alignItems: "center", gap: 8, color: COLORS.muted, fontSize: 13, ...lift(frame, 40 + index * 9)}}>
                  <span style={{color: COLORS.green, fontSize: 16}}>✓</span>
                  {item}
                </div>
              ))}
            </div>
          </div>
        </div>
      </Panel>

      <Panel style={{position: "absolute", left: 852, top: 4, width: 210, height: 356, padding: 20, ...drift(frame, 25)}} accent={COLORS.cyan}>
        <div style={{...labelStyle, color: COLORS.cyan}}>REUSE THIS VIEW</div>
        <div style={{marginTop: 16, display: "grid", gap: 12}}>
          {reuse.map(([name, detail, color], index) => (
            <div key={name} style={{padding: 15, borderRadius: 12, backgroundColor: COLORS.panelRaised, border: `1px solid ${color}55`, ...lift(frame, 35 + index * 12)}}>
              <div style={{fontSize: 13, fontWeight: 800, letterSpacing: 1.3, color}}>{name}</div>
              <div style={{marginTop: 8, color: COLORS.muted, fontSize: 13}}>{detail}</div>
            </div>
          ))}
        </div>
        <div style={{position: "absolute", left: 20, right: 20, bottom: 20, color: COLORS.faint, fontSize: 12}}>one artifact, many returns</div>
      </Panel>
    </SceneFrame>
  );
}

function SceneSix() {
  const frame = useCurrentFrame();
  const reportRows = ["system shape", "implementation details", "source links"];
  const briefingRows = ["current status", "difficult decisions", "evidence that matters", "next action"];

  return (
    <SceneFrame
      index={5}
      title="A report explains. A briefing orients."
      subtitle="The static artifact gives shape; the handoff still needs time and state."
    >
      <Panel style={{position: "absolute", left: 0, top: 12, width: 472, height: 326, padding: 24, ...lift(frame, 4)}} accent={COLORS.cyan}>
        <Tag color={COLORS.cyan} soft={COLORS.cyanSoft}>REPORT</Tag>
        <div style={{marginTop: 19, color: COLORS.ink, fontSize: 23, fontWeight: 720}}>Good for understanding the shape</div>
        <div style={{marginTop: 20, borderTop: `1px solid ${COLORS.lineSoft}`}}>
          {reportRows.map((row, index) => (
            <div key={row} style={{display: "flex", alignItems: "center", gap: 13, padding: "16px 0", borderBottom: `1px solid ${COLORS.lineSoft}`, color: COLORS.muted, fontSize: 16, ...lift(frame, 22 + index * 12)}}>
              <span style={{color: COLORS.cyan}}>●</span>
              {row}
            </div>
          ))}
        </div>
      </Panel>

      <div style={{position: "absolute", left: 484, top: 138, width: 88, textAlign: "center", ...pulse(frame, 30)}}>
        <div style={{color: COLORS.yellow, fontSize: 34, fontWeight: 500}}>≠</div>
        <div style={{marginTop: 8, color: COLORS.faint, fontSize: 11, fontWeight: 750, letterSpacing: 1.2}}>ORIENTATION</div>
      </div>

      <Panel style={{position: "absolute", left: 590, top: 12, width: 472, height: 326, padding: 24, ...drift(frame, 20)}} accent={COLORS.yellow}>
        <Tag color={COLORS.yellow} soft={COLORS.yellowSoft}>BRIEFING</Tag>
        <div style={{marginTop: 19, color: COLORS.ink, fontSize: 23, fontWeight: 720}}>Still needed when you step back in</div>
        <div style={{marginTop: 20, borderTop: `1px solid ${COLORS.lineSoft}`}}>
          {briefingRows.map((row, index) => (
            <div key={row} style={{display: "flex", alignItems: "center", gap: 13, padding: "12px 0", borderBottom: `1px solid ${COLORS.lineSoft}`, color: COLORS.muted, fontSize: 16, ...lift(frame, 34 + index * 12)}}>
              <span style={{color: COLORS.yellow}}>?</span>
              {row}
            </div>
          ))}
        </div>
      </Panel>

      <div style={{position: "absolute", left: 230, top: 353, color: COLORS.faint, fontSize: 13, letterSpacing: 1.1, textTransform: "uppercase", ...lift(frame, 75)}}>
        understanding tells you how it works · orientation tells you what to do
      </div>
    </SceneFrame>
  );
}

function SceneSeven() {
  const frame = useCurrentFrame();
  const moments = [
    ["STATUS", "what matters now", COLORS.cyan],
    ["CONTEXT", "where we are", COLORS.purple],
    ["CHANGE", "what moved", COLORS.yellow],
    ["EVIDENCE", "why believe it", COLORS.green],
    ["NEXT", "what to do", COLORS.coral],
  ] as const;
  const views = ["H T M L", "PLAYER", "SLIDES", "VIDEO"];

  return (
    <SceneFrame
      index={6}
      title="Make the brief temporal"
      subtitle="Put the current state on a timeline, then derive the view you need."
    >
      <div style={{position: "absolute", left: 20, top: 15, width: 1020}}>
        <div style={{position: "absolute", left: 42, right: 42, top: 47, height: 3, backgroundColor: COLORS.line}} />
        {moments.map(([name, detail, color], index) => {
          const left = index * 238;
          return (
            <div key={name} style={{position: "absolute", left, top: 0, width: 180, ...lift(frame, 8 + index * 11)}}>
              <div style={{display: "flex", justifyContent: "center"}}>
                <div style={{width: 22, height: 22, borderRadius: "50%", backgroundColor: COLORS.background, border: `3px solid ${color}`, boxShadow: `0 0 18px ${color}55`}} />
              </div>
              <div style={{marginTop: 16, textAlign: "center", color, fontSize: 13, fontWeight: 800, letterSpacing: 1.2}}>{name}</div>
              <div style={{marginTop: 7, textAlign: "center", color: COLORS.muted, fontSize: 13}}>{detail}</div>
            </div>
          );
        })}
      </div>

      <Panel style={{position: "absolute", left: 0, top: 172, width: 255, height: 130, padding: 21, ...lift(frame, 68)}} accent={COLORS.cyan}>
        <div style={{...labelStyle, color: COLORS.cyan}}>ONE BRIEF</div>
        <div style={{marginTop: 13, color: COLORS.ink, fontSize: 21, fontWeight: 720}}>A current story of the work</div>
      </Panel>
      <FlowArrow left={273} top={222} width={62} />

      <div style={{position: "absolute", left: 356, top: 172, display: "flex", gap: 13}}>
        {views.map((view, index) => (
          <div key={view} style={{width: 145, height: 130, padding: 19, boxSizing: "border-box", borderRadius: 15, backgroundColor: COLORS.panel, border: `1px solid ${[COLORS.cyan, COLORS.purple, COLORS.yellow, COLORS.green][index]}66`, ...lift(frame, 78 + index * 10)}}>
            <div style={{fontSize: 15, fontWeight: 800, letterSpacing: 1.2, color: [COLORS.cyan, COLORS.purple, COLORS.yellow, COLORS.green][index]}}>{view}</div>
            <div style={{marginTop: 14, display: "grid", gap: 7}}>
              <div style={{height: 5, width: "86%", backgroundColor: COLORS.line, borderRadius: 4}} />
              <div style={{height: 5, width: "65%", backgroundColor: COLORS.lineSoft, borderRadius: 4}} />
              <div style={{height: 5, width: "74%", backgroundColor: COLORS.lineSoft, borderRadius: 4}} />
            </div>
          </div>
        ))}
      </div>

      <div style={{position: "absolute", left: 322, top: 329, color: COLORS.ink, fontSize: 17, fontWeight: 650, ...lift(frame, 110)}}>
        one source of truth → many ways to understand it
      </div>
    </SceneFrame>
  );
}

function Background() {
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(circle at 78% 9%, #193354 0%, transparent 35%), linear-gradient(135deg, ${COLORS.background} 0%, ${COLORS.backgroundMid} 100%)`,
        fontFamily: FONT_FAMILY,
        color: COLORS.ink,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.12,
          backgroundImage: "linear-gradient(rgba(140, 190, 230, 0.2) 1px, transparent 1px), linear-gradient(90deg, rgba(140, 190, 230, 0.2) 1px, transparent 1px)",
          backgroundSize: "64px 64px",
          maskImage: "linear-gradient(to bottom, black, transparent 75%)",
        }}
      />
    </AbsoluteFill>
  );
}

function GlobalHeader({activeIndex}: {activeIndex: number}) {
  return (
    <>
      <div style={{position: "absolute", left: 72, top: 25, zIndex: 10, display: "flex", alignItems: "center", gap: 12}}>
        <div style={{width: 12, height: 12, borderRadius: 4, backgroundColor: COLORS.cyan, boxShadow: `0 0 18px ${COLORS.cyan}`}} />
        <div style={{color: COLORS.ink, fontSize: 13, fontWeight: 800, letterSpacing: 2.2}}>COMPREHENSION</div>
        <div style={{color: COLORS.faint, fontSize: 12, letterSpacing: 1.2}}>A TEMPORAL BRIEF FOR AGENT WORK</div>
      </div>
      <div style={{position: "absolute", left: 72, right: 72, top: 66, height: 1, backgroundColor: COLORS.lineSoft, zIndex: 10}} />
      <div style={{position: "absolute", right: 72, top: 25, zIndex: 10, display: "flex", alignItems: "center", gap: 11}}>
        {CHAPTERS.map((chapter, index) => (
          <div key={chapter} style={{display: "flex", flexDirection: "column", alignItems: "center", gap: 6, opacity: index === activeIndex ? 1 : 0.45}}>
            <div style={{width: 38, height: 4, borderRadius: 4, backgroundColor: index === activeIndex ? COLORS.cyan : COLORS.line}} />
            {index === activeIndex ? <div style={{fontSize: 9, color: COLORS.cyan, letterSpacing: 1.1, fontWeight: 800}}>{chapter}</div> : null}
          </div>
        ))}
      </div>
    </>
  );
}

function Footer({frame}: {frame: number}) {
  const activeIndex = getActiveChapter(frame);
  const seconds = Math.floor(frame / FPS);
  const minutesPart = String(Math.floor(seconds / 60)).padStart(2, "0");
  const secondsPart = String(seconds % 60).padStart(2, "0");
  return (
    <div style={{position: "absolute", left: 72, right: 72, bottom: 21, zIndex: 10, display: "flex", justifyContent: "space-between", color: COLORS.faint, fontSize: 11, letterSpacing: 1.3}}>
      <span>COMPREHENSION / {String(activeIndex + 1).padStart(2, "0")} — 07</span>
      <span>{minutesPart}:{secondsPart}</span>
    </div>
  );
}

function getActiveChapter(frame: number) {
  const chapter = SCENE_STARTS.findIndex((start, index) => frame >= start && frame < start + SCENE_DURATIONS[index]);
  return chapter === -1 ? CHAPTERS.length - 1 : chapter;
}

function ClosedCaptions() {
  const frame = useCurrentFrame();
  const cue = CAPTION_CUES.find((candidate) => frame >= candidate.start && frame < candidate.end);
  if (!cue) return null;

  const cueFrame = frame - cue.start;
  const cueDuration = cue.end - cue.start;
  const fadeIn = interpolate(cueFrame, [0, 8], [0, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"});
  const fadeOut = interpolate(cueDuration - cueFrame, [0, 10], [0, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"});
  return (
    <div
      style={{
        position: "absolute",
        left: 142,
        right: 142,
        top: 584,
        height: 78,
        zIndex: 20,
        display: "flex",
        alignItems: "center",
        gap: 19,
        padding: "0 24px",
        boxSizing: "border-box",
        borderRadius: 14,
        backgroundColor: "rgba(4, 10, 20, 0.95)",
        border: `1px solid ${COLORS.cyan}80`,
        boxShadow: "0 12px 35px rgba(0, 0, 0, 0.25)",
        opacity: fadeIn * fadeOut,
      }}
    >
      <span style={{padding: "7px 8px", borderRadius: 7, backgroundColor: COLORS.cyanSoft, color: COLORS.cyan, fontSize: 12, fontWeight: 900, letterSpacing: 1}}>CC</span>
      <span style={{color: COLORS.ink, fontSize: 22, lineHeight: 1.25, fontWeight: 520, maxHeight: 56, overflow: "hidden"}}>{cue.text}</span>
    </div>
  );
}

export const ComprehensionBrief = () => {
  const frame = useCurrentFrame();
  const activeIndex = getActiveChapter(frame);
  return (
    <AbsoluteFill style={{fontFamily: FONT_FAMILY}}>
      <Background />
      <AbsoluteFill style={{zIndex: 2}}>
        <Sequence from={SCENE_STARTS[0]} durationInFrames={SCENE_DURATIONS[0]}>
          <SceneOne />
        </Sequence>
        <Sequence from={SCENE_STARTS[1]} durationInFrames={SCENE_DURATIONS[1]}>
          <SceneTwo />
        </Sequence>
        <Sequence from={SCENE_STARTS[2]} durationInFrames={SCENE_DURATIONS[2]}>
          <SceneThree />
        </Sequence>
        <Sequence from={SCENE_STARTS[3]} durationInFrames={SCENE_DURATIONS[3]}>
          <SceneFour />
        </Sequence>
        <Sequence from={SCENE_STARTS[4]} durationInFrames={SCENE_DURATIONS[4]}>
          <SceneFive />
        </Sequence>
        <Sequence from={SCENE_STARTS[5]} durationInFrames={SCENE_DURATIONS[5]}>
          <SceneSix />
        </Sequence>
        <Sequence from={SCENE_STARTS[6]} durationInFrames={SCENE_DURATIONS[6]}>
          <SceneSeven />
        </Sequence>
      </AbsoluteFill>
      <GlobalHeader activeIndex={activeIndex} />
      <Footer frame={frame} />
      <ClosedCaptions />
      <Audio src={staticFile("narration.wav")} volume={0.95} />
    </AbsoluteFill>
  );
};
