import makeEditors from "./editor";
import { COMPILE_BUTTON, RUN_BUTTON, THEME_TOGGLE } from "./constants";
import { $ } from "./dom";
import { compileQuery, runCompiledQuery } from "./execute";
import * as Codemirror from "codemirror";
import {
  Braces,
  ChevronDown,
  createIcons,
  ExternalLink,
  MoonStar,
  Play,
  SunMedium,
} from "lucide";
import { siGithub } from "simple-icons";

main();

export default function main() {
  const githubIcon = document.getElementById("github-icon");
  if (githubIcon) {
    const githubTemplate = document.createElement("template");
    githubTemplate.innerHTML = siGithub.svg;
    const githubMark = githubTemplate.content.firstElementChild;

    if (githubMark instanceof SVGElement) {
      githubMark.classList.add("github-icon");
      githubMark.setAttribute("aria-hidden", "true");
      githubMark.removeAttribute("role");
      githubMark.querySelector("title")?.remove();
      githubIcon.replaceWith(githubMark);
    }
  }

  createIcons({
    icons: { Braces, ChevronDown, ExternalLink, MoonStar, Play, SunMedium },
  });

  const editors = makeEditors();
  const compileButton = $<HTMLButtonElement>(COMPILE_BUTTON);
  const runButton = $<HTMLButtonElement>(RUN_BUTTON);
  const themeToggle = $<HTMLButtonElement>(THEME_TOGGLE);
  const sourceEditors = {
    query: editors.query.editor,
    schema: editors.schema.editor,
    resolvers: editors.resolvers.editor,
  };
  const workspaceEditors = [
    editors.query.editor,
    editors.schema.editor,
    editors.resolvers.editor,
    editors.compiledQuery.editor,
    editors.exectionResult.editor,
  ];
  const sourceEditorBreakpoint = window.matchMedia("(max-width: 700px)");
  let theme = readTheme();
  let selectedSource: SourceEditor = "query";
  let sourceRefreshTimeout: number | undefined;
  let sourceVersion = 0;
  let compiledSourceVersion: number | undefined;
  let isRunning = false;
  const sourceAccordions = (Object.keys(sourceEditors) as SourceEditor[]).map(
    (source) => {
      const button = $<HTMLButtonElement>(`${source}-trigger`);

      return {
        source,
        button,
        panel: $<HTMLElement>(`${source}-panel`),
        accordion: button.closest<HTMLElement>(".editor-accordion")!,
      };
    },
  );

  sourceAccordions.forEach(({ source, button }) => {
    button.addEventListener("click", () => {
      if (sourceEditorBreakpoint.matches) return;

      selectedSource = source;
      setDesktopSource(selectedSource);
    });
  });

  sourceEditorBreakpoint.addEventListener("change", syncSourceLayout);
  syncSourceLayout();
  setTheme(theme);

  themeToggle.addEventListener("click", () => {
    theme = theme === "dark" ? "light" : "dark";
    setTheme(theme);
  });

  Object.values(sourceEditors).forEach((editor) => {
    editor.on("change", () => {
      sourceVersion += 1;
      updateRunButton();
    });
  });

  compileButton.addEventListener("click", async () => {
    const versionBeingCompiled = sourceVersion;
    compileButton.disabled = true;
    compileButton.dataset.state = "compiling";
    compileButton.setAttribute("aria-busy", "true");
    compileButton.setAttribute("aria-label", "Compiling query");
    compiledSourceVersion = undefined;
    updateRunButton();
    editors.exectionResult.editor.getDoc().setValue("");

    try {
      const reply = await compileQuery(
        getValue(editors.schema),
        getValue(editors.resolvers),
        getValue(editors.query),
      );

      if (versionBeingCompiled !== sourceVersion) {
        return;
      }

      editors.compiledQuery.editor.getDoc().setValue(reply.compiledQuery);
      if (reply.ready) {
        compiledSourceVersion = versionBeingCompiled;
      }
    } catch (e) {
      if (versionBeingCompiled !== sourceVersion) {
        return;
      }

      const error = e instanceof Error ? e : new Error(String(e));
      editors.compiledQuery.editor
        .getDoc()
        .setValue(error.message + "\n" + error.stack);
    } finally {
      compileButton.disabled = false;
      delete compileButton.dataset.state;
      compileButton.removeAttribute("aria-busy");
      compileButton.setAttribute("aria-label", "Compile query");
      updateRunButton();
    }
  });

  runButton.addEventListener("click", async () => {
    if (compiledSourceVersion !== sourceVersion) return;

    isRunning = true;
    compileButton.disabled = true;
    runButton.dataset.state = "running";
    runButton.setAttribute("aria-busy", "true");
    runButton.setAttribute("aria-label", "Running compiled query");
    updateRunButton();

    try {
      const reply = await runCompiledQuery();
      editors.exectionResult.editor.getDoc().setValue(reply.executionResult);
    } catch (e) {
      compiledSourceVersion = undefined;
      const error = e instanceof Error ? e : new Error(String(e));
      editors.exectionResult.editor
        .getDoc()
        .setValue(error.message + "\n" + error.stack);
    } finally {
      isRunning = false;
      compileButton.disabled = false;
      delete runButton.dataset.state;
      runButton.removeAttribute("aria-busy");
      runButton.setAttribute("aria-label", "Run compiled query");
      updateRunButton();
    }
  });

  (window as any).editors = editors;

  function syncSourceLayout() {
    const isMobile = sourceEditorBreakpoint.matches;

    workspaceEditors.forEach((editor) => {
      editor.setOption("viewportMargin", isMobile ? Infinity : 10);
      editor.setSize(null, isMobile ? "auto" : "100%");
    });

    if (isMobile) {
      sourceAccordions.forEach(({ source, button, panel, accordion }) => {
        button.disabled = true;
        button.setAttribute("aria-expanded", "true");
        accordion.classList.add("is-expanded");
        panel.hidden = false;
        requestAnimationFrame(() => sourceEditors[source].refresh());
      });
      requestAnimationFrame(() => {
        workspaceEditors.forEach((editor) => editor.refresh());
      });
      return;
    }

    sourceAccordions.forEach(({ button }) => {
      button.disabled = false;
    });
    setDesktopSource(selectedSource);
  }

  function setDesktopSource(nextSource: SourceEditor) {
    sourceAccordions.forEach(({ source, button, panel, accordion }) => {
      const isExpanded = source === nextSource;
      button.setAttribute("aria-expanded", String(isExpanded));
      accordion.classList.toggle("is-expanded", isExpanded);
      panel.hidden = !isExpanded;
    });

    requestAnimationFrame(() => sourceEditors[nextSource].refresh());

    if (sourceRefreshTimeout !== undefined) {
      window.clearTimeout(sourceRefreshTimeout);
    }

    sourceRefreshTimeout = window.setTimeout(() => {
      sourceEditors[nextSource].refresh();
      sourceRefreshTimeout = undefined;
    }, 260);
  }

  function setTheme(nextTheme: Theme) {
    document.documentElement.dataset.theme = nextTheme;
    const nextThemeName = nextTheme === "dark" ? "light" : "dark";
    const label = `Switch to ${nextThemeName} mode`;

    themeToggle.setAttribute("aria-label", label);
    themeToggle.setAttribute("aria-pressed", String(nextTheme === "light"));
    themeToggle.title = label;
    window.localStorage.setItem("theme", nextTheme);
  }

  function updateRunButton() {
    const canRun = !isRunning && compiledSourceVersion === sourceVersion;
    runButton.disabled = !canRun;
    runButton.title = canRun
      ? "Run compiled query"
      : "Compile the current source before running it";
  }
}

type SourceEditor = "query" | "schema" | "resolvers";
type Theme = "dark" | "light";

function readTheme(): Theme {
  return window.localStorage.getItem("theme") === "light" ? "light" : "dark";
}

function getValue(e: { editor: Codemirror.Editor }) {
  return e.editor.getValue();
}
