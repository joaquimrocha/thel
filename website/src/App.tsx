import { useEffect, useRef, useState } from "react";

const REPO = "https://github.com/joaquimrocha/thel";

type Feature = {
  title: string;
  desc: React.ReactNode;
  link?: { label: string; href: string };
};

const FEATURES: Feature[] = [
  {
    title: "Persistent sessions",
    desc: "A background daemon owns your PTYs, so terminals survive restarting the app and reattach with their screen restored.",
  },
  {
    title: "Worktree-aware sessions",
    desc: "Anchor a session to a folder or git worktree, or create a new worktree right from the New Session dialog.",
  },
  {
    title: "Splits and tabs",
    desc: "Divide a session into panes, each with its own tab strip. Drag tabs to reorder or move them between panes.",
  },
  {
    title: "Notifications",
    desc: (
      <>
        Auto-detected attention (a finished command, a bell, an agent done and
        waiting) as in-app dots and OS banners. Wire agents to it with{" "}
        <code className="font-mono text-[13px]">thel notify</code>.
      </>
    ),
    link: { label: "More on notifications ↗", href: `${REPO}#notifications` },
  },
  {
    title: "Keyboard-friendly",
    desc: "Every major action is reachable from a fuzzy command palette or direct shortcuts, and the keymap is fully rebindable and persisted.",
  },
  {
    title: "Session icons",
    desc: "Assign custom icons to your sessions to identify them at a glance in the sidebar.",
  },
  {
    title: "Launchers",
    desc: "Save the commands you start often, such as an agent or a REPL, with session variables like __SESSION_DIR__, and pick the default that new terminals launch.",
  },
  {
    title: "Profiles",
    desc: "Independent profiles, each in its own window with its own saved layout and accent color.",
  },
];

const SHOTS = [
  {
    src: "/screenshot.png",
    title: "Split panes",
    desc: "A coding agent beside a shell.",
  },
  {
    src: "/shots/command-palette.png",
    title: "Command palette",
    desc: "Jump to any session or launcher.",
  },
  {
    src: "/shots/new-session-worktree.png",
    title: "Git worktrees",
    desc: "Anchor a session to a new worktree.",
  },
  {
    src: "/shots/launchers.png",
    title: "Launchers",
    desc: "Saved commands with session variables.",
  },
  {
    src: "/shots/profiles.png",
    title: "Profiles",
    desc: "Separate windows, each with its own accent.",
  },
  {
    src: "/shots/notifications.png",
    title: "Notifications",
    desc: "Activity in terminals you weren't watching.",
  },
];


// The app's busy-terminal dot: solid, under an expanding, fading ring.
function StatusDot() {
  return (
    <span className="relative flex size-[7px]">
      <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-75 motion-safe:animate-ping" />
      <span className="relative inline-flex h-full w-full rounded-full bg-accent" />
    </span>
  );
}

// A green section kicker. Every accent-colored section label carries the
// status dot, echoing a running terminal.
function Kicker({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2.5 font-mono text-xs uppercase tracking-[0.16em] text-accent">
      <StatusDot />
      {children}
    </span>
  );
}

function Header() {
  return (
    <header className="flex items-center justify-between border-b border-white/5 px-6 py-5 sm:px-10">
      <div className="flex items-center gap-3">
        <img src="/thel-logo.png" alt="" className="size-6" />
        <span className="font-mono text-base font-medium text-ink-bright">
          thel
        </span>
      </div>
      <a
        href={REPO}
        target="_blank"
        rel="noopener"
        className="font-mono text-sm text-ink-muted transition-colors hover:text-ink-bright"
      >
        GitHub ↗
      </a>
    </header>
  );
}

function Hero() {
  // The release page always works; when the GitHub API answers, the button
  // upgrades to a direct download of the release tarball (its filename embeds
  // the version, so it can't be hardcoded).
  const [tarball, setTarball] = useState(`${REPO}/releases/latest`);
  useEffect(() => {
    fetch("https://api.github.com/repos/joaquimrocha/thel/releases/latest")
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (rel: {
          assets?: { name: string; browser_download_url: string }[];
        } | null) => {
          const url = rel?.assets?.find((a) =>
            /\.tar\.(xz|gz)$/.test(a.name),
          )?.browser_download_url;
          if (url) setTarball(url);
        },
      )
      .catch(() => {});
  }, []);

  return (
    <section className="px-6 pb-14 pt-20 text-center sm:px-10">
      <div className="inline-flex items-center gap-2.5">
        <StatusDot />
        <span className="font-mono text-xs uppercase tracking-[0.16em] text-ink-faint">
          Your sessions keep working. You keep track.
        </span>
      </div>
      <h1 className="mx-auto mt-6 max-w-[24ch] text-balance text-5xl font-semibold leading-[1.05] tracking-tight text-ink sm:text-6xl">
        The home for your long-running sessions
      </h1>
      <p className="mx-auto mt-6 max-w-[54ch] text-pretty text-lg leading-relaxed text-ink-muted">
        thel is a terminal app that keeps every session alive in the
        background, built for AI coding agents and anything else that runs
        long. Anchor each to its own git worktree, run a fleet of them at
        once, and tell at a glance which one needs you.
      </p>
      <div className="mt-9 flex flex-wrap items-center justify-center gap-4">
        <a
          href={tarball}
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-3 font-mono text-sm font-semibold text-on-accent transition-[filter] hover:brightness-110"
        >
          Download for Linux
        </a>
        <a
          href={REPO}
          target="_blank"
          rel="noopener"
          className="font-mono text-sm text-ink-muted transition-colors hover:text-accent"
        >
          or view on GitHub ↗
        </a>
      </div>
      <p className="mt-8">
        <span className="rounded-full border border-white/10 px-3 py-1.5 font-mono text-xs text-ink-faint">
          Beta: Linux only; Mac + Windows coming soon
        </span>
      </p>
    </section>
  );
}

function Screenshot() {
  return (
    <section className="relative px-4 sm:px-10">
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-8 h-3/4 w-3/5 -translate-x-1/2 bg-[radial-gradient(ellipse_at_center,rgb(16_185_129/0.20),transparent_70%)] blur-[64px]"
      />
      <img
        src="/screenshot.png"
        alt="thel with a coding agent and a shell in split panes"
        className="relative w-full rounded-2xl border border-white/10 bg-terminal shadow-[0_34px_90px_-42px_rgb(0_0_0/0.85)]"
      />
    </section>
  );
}

function Features() {
  return (
    <section className="px-6 pb-6 pt-20 sm:px-10">
      <div className="text-center">
        <Kicker>Features</Kicker>
        <h2 className="mt-3.5 text-3xl font-semibold tracking-tight text-ink-bright">
          A calmer way to run your terminals
        </h2>
      </div>
      <div className="mt-9 grid gap-px overflow-hidden rounded-2xl border border-white/5 bg-white/5 sm:grid-cols-2">
        {FEATURES.map((f) => (
          <div key={f.title} className="bg-panel px-6 py-7">
            <h3 className="mb-2 flex items-baseline gap-2.5 text-lg font-semibold tracking-tight text-ink-bright">
              <span className="font-mono text-accent">/</span>
              {f.title}
            </h3>
            <p className="text-sm leading-relaxed text-ink-muted">{f.desc}</p>
            {f.link && (
              <a
                href={f.link.href}
                target="_blank"
                rel="noopener"
                className="mt-3 inline-block font-mono text-xs text-ink-faint transition-colors hover:text-accent"
              >
                {f.link.label}
              </a>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function Gallery() {
  const strip = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const shot = SHOTS[Math.min(index, SHOTS.length - 1)];

  // scrollTo without `behavior` follows the CSS scroll-behavior, so the
  // motion-safe:scroll-smooth class keeps this instant under reduced motion.
  const goTo = (i: number) => {
    const el = strip.current;
    if (!el) return;
    const n = (i + SHOTS.length) % SHOTS.length;
    el.scrollTo({ left: n * el.clientWidth });
  };

  // Auto-advance. Keyed on `index`, so any manual navigation resets the
  // timer; paused while hovered or focused, and off under reduced motion.
  useEffect(() => {
    if (paused) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = window.setTimeout(() => goTo(index + 1), 5000);
    return () => window.clearTimeout(t);
  }, [index, paused]);

  return (
    <section
      className="px-6 pt-20 sm:px-10"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className="text-center">
        <Kicker>In action</Kicker>
        <h2 className="mt-3.5 text-3xl font-semibold tracking-tight text-ink-bright">
          A look around
        </h2>
      </div>
      <div
        ref={strip}
        aria-roledescription="carousel"
        onScroll={(e) => {
          const el = e.currentTarget;
          setIndex(Math.round(el.scrollLeft / el.clientWidth));
        }}
        className="mt-9 flex snap-x snap-mandatory overflow-x-auto rounded-2xl border border-white/10 bg-terminal [scrollbar-width:none] [&::-webkit-scrollbar]:hidden motion-safe:scroll-smooth"
      >
        {SHOTS.map((s) => (
          <img
            key={s.src}
            src={s.src}
            alt={`${s.title}: ${s.desc}`}
            loading="lazy"
            className="w-full shrink-0 snap-center object-contain"
          />
        ))}
      </div>
      <p aria-live="polite" className="mt-5 text-center text-sm text-ink-muted">
        <span className="font-semibold text-ink-bright">{shot.title}.</span>{" "}
        {shot.desc}
      </p>
      <div className="mt-3 flex justify-center gap-2">
        {SHOTS.map((s, i) => (
          <button
            key={s.src}
            aria-label={`Go to ${s.title}`}
            aria-current={i === index}
            onClick={() => goTo(i)}
            className={`size-2 cursor-pointer rounded-full transition-colors ${i === index ? "bg-accent" : "bg-white/20 hover:bg-white/40"}`}
          />
        ))}
      </div>
    </section>
  );
}

function Callout() {
  return (
    <section className="px-6 pb-2 pt-14 sm:px-10">
      <div className="rounded-2xl border border-accent/25 bg-accent/5 px-8 py-11 text-center">
        <h2 className="text-2xl font-semibold tracking-tight text-ink">
          Give your sessions a home
        </h2>
        <p className="mx-auto mt-3.5 max-w-[46ch] text-[15px] leading-relaxed text-ink-muted">
          thel is free, Apache-2.0 licensed, and built in the open. Want the
          details? Read{" "}
          <a
            href={`${REPO}/tree/main/docs`}
            target="_blank"
            rel="noopener"
            className="underline decoration-white/30 underline-offset-2 transition-colors hover:text-ink-bright"
          >
            the docs
          </a>
          .
        </p>
        <a
          href={REPO}
          target="_blank"
          rel="noopener"
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-3 font-mono text-sm font-semibold text-on-accent transition-[filter] hover:brightness-110"
        >
          Get thel on GitHub ↗
        </a>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t border-white/5 px-6 py-9 sm:px-10">
      <div className="flex items-center gap-2.5">
        <img src="/thel-logo.png" alt="" className="size-[18px] opacity-85" />
        <span className="font-mono text-sm text-ink-faint">
          thel · ©&nbsp;2026{" "}
          <a
            href="https://joaquimrocha.com"
            target="_blank"
            rel="noopener"
            className="transition-colors hover:text-ink-bright"
          >
            Joaquim Rocha
          </a>
        </span>
      </div>
      <nav className="flex items-center gap-5">
        {[
          ["GitHub", REPO],
          ["Issues", `${REPO}/issues`],
          ["License", `${REPO}/blob/main/LICENSE`],
        ].map(([label, href]) => (
          <a
            key={label}
            href={href}
            target="_blank"
            rel="noopener"
            className="font-mono text-sm text-ink-faint transition-colors hover:text-ink-bright"
          >
            {label}
          </a>
        ))}
      </nav>
    </footer>
  );
}

export function App() {
  return (
    <div className="mx-auto max-w-4xl">
      <Header />
      <main>
        <Hero />
        <Screenshot />
        <Features />
        <Gallery />
        <Callout />
      </main>
      <Footer />
    </div>
  );
}
