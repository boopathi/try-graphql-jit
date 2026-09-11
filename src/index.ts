import makeEditors from "./editor";
import { EXECUTE_BUTTON, THEME_TOGGLE } from "./constants";
import { $ } from "./dom";
import { executeQuery } from "./execute";
import * as Codemirror from "codemirror";
import {
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
    icons: { ChevronDown, ExternalLink, MoonStar, Play, SunMedium },
  });

  const editors = makeEditors();
  const executeButton = $<HTMLButtonElement>(EXECUTE_BUTTON);
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

  executeButton.addEventListener("click", async () => {
    executeButton.disabled = true;
    executeButton.dataset.state = "running";
    executeButton.setAttribute("aria-busy", "true");
    executeButton.setAttribute("aria-label", "Running query");

    try {
      const reply = await executeQuery(
        getValue(editors.schema),
        getValue(editors.resolvers),
        getValue(editors.query),
      );
      editors.compiledQuery.editor.getDoc().setValue(reply.compiledQuery);
      editors.exectionResult.editor.getDoc().setValue(reply.executionResult);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      editors.exectionResult.editor
        .getDoc()
        .setValue(error.message + "\n" + error.stack);
    } finally {
      executeButton.disabled = false;
      delete executeButton.dataset.state;
      executeButton.removeAttribute("aria-busy");
      executeButton.setAttribute("aria-label", "Run query");
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
}

type SourceEditor = "query" | "schema" | "resolvers";
type Theme = "dark" | "light";

function readTheme(): Theme {
  return window.localStorage.getItem("theme") === "light" ? "light" : "dark";
}

function getValue(e: { editor: Codemirror.Editor }) {
  return e.editor.getValue();
}
