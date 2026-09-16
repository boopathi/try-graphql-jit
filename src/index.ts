import makeEditors from "./editor";
import { supportsGraphqlJitDebugging } from "./graphql-jit-version";
import {
  CALL_STACK_LIST,
  CLEAR_BREAKPOINTS_BUTTON,
  COMPILE_BUTTON,
  DEBUG_CONTINUE_BUTTON,
  DEBUG_CONTROLS,
  DEBUG_RUN_TO_COMPLETION_BUTTON,
  DEBUG_STATUS,
  DEBUG_STEP_BUTTON,
  RUN_BUTTON,
  THEME_TOGGLE,
  WATCH_FORM,
  WATCH_INPUT,
  WATCH_LIST,
} from "./constants";
import { $ } from "./dom";
import {
  compileQuery,
  evaluateDebugWatch,
  evaluateDebugHover,
  expandDebugWatch,
  onDebugPause,
  resumeDebug,
  runCompiledQuery,
} from "./execute";
import type { BreakpointLocation, DebugWatchValue } from "./debug-protocol";
import * as Codemirror from "codemirror";
import {
  Braces,
  ChevronDown,
  Eraser,
  createIcons,
  ExternalLink,
  FastForward,
  MoonStar,
  Play,
  RedoDot,
  StepForward,
  SunMedium,
} from "lucide";
import { siGithub } from "simple-icons";

main();

export default function main() {
  document.documentElement.dataset.graphqlJitDebugging = String(
    supportsGraphqlJitDebugging,
  );
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
    icons: {
      Braces,
      ChevronDown,
      Eraser,
      ExternalLink,
      FastForward,
      MoonStar,
      Play,
      RedoDot,
      StepForward,
      SunMedium,
    },
  });

  const editors = makeEditors(supportsGraphqlJitDebugging);
  const compileButton = $<HTMLButtonElement>(COMPILE_BUTTON);
  const runButton = $<HTMLButtonElement>(RUN_BUTTON);
  const clearBreakpointsButton = $<HTMLButtonElement>(CLEAR_BREAKPOINTS_BUTTON);
  const continueButton = $<HTMLButtonElement>(DEBUG_CONTINUE_BUTTON);
  const runToCompletionButton = $<HTMLButtonElement>(
    DEBUG_RUN_TO_COMPLETION_BUTTON,
  );
  const stepButton = $<HTMLButtonElement>(DEBUG_STEP_BUTTON);
  const debugControls = $<HTMLElement>(DEBUG_CONTROLS);
  const debugStatus = $<HTMLElement>(DEBUG_STATUS);
  const watchForm = $<HTMLFormElement>(WATCH_FORM);
  const watchInput = $<HTMLInputElement>(WATCH_INPUT);
  const watchList = $<HTMLUListElement>(WATCH_LIST);
  const callStackList = $<HTMLUListElement>(CALL_STACK_LIST);
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
  let sourceVersion = 0;
  let compiledSourceVersion: number | undefined;
  let compiledQuerySource = "";
  let isRunning = false;
  let breakpointIdsByLine = new Map<number, number[]>();
  let breakpointLocationsById = new Map<number, BreakpointLocation>();
  let activeBreakpointIds = new Set<number>();
  let expandedBreakpointLine: number | undefined;
  let pausedBreakpointId: number | undefined;
  let inlineBreakpointMarkers: Codemirror.TextMarker[] = [];
  let pausedLine: number | undefined;
  let isDebugPaused = false;
  let pauseVersion = 0;
  let hasOpenedDebugInspectors = false;
  let isEvaluatingWatches = false;
  let nextWatchId = 0;
  let callStack: CallStackFrame[] = [];
  let isShowingInternalCallStackFrames = false;
  let hoverTimer: number | undefined;
  let hoveredIdentifier: HoveredIdentifier | undefined;
  let hoveredIdentifierMarker: Codemirror.TextMarker | undefined;
  const hoverTooltip = makeHoverTooltip();
  const watchedExpressions: WatchedExpression[] = [];
  const sourceAccordions = (Object.keys(sourceEditors) as SourceEditor[]).map(
    (source) => makeCollapsibleSection(source, sourceEditors[source]),
  );
  const watchSection = makeCollapsibleSection("watch");
  const callStackSection = makeCollapsibleSection("call-stack");
  const collapsibleSections = supportsGraphqlJitDebugging
    ? [...sourceAccordions, watchSection, callStackSection]
    : sourceAccordions;

  collapsibleSections.forEach((section) => {
    section.button.addEventListener("click", () => {
      if (sourceEditorBreakpoint.matches) return;

      setCollapsibleSectionExpanded(
        section,
        !section.accordion.classList.contains("is-expanded"),
      );
    });
  });

  sourceEditorBreakpoint.addEventListener("change", syncSourceLayout);
  syncSourceLayout();
  setTheme(theme);
  renderWatchList();
  renderCallStack();

  themeToggle.addEventListener("click", () => {
    theme = theme === "dark" ? "light" : "dark";
    setTheme(theme);
  });

  watchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const expression = watchInput.value.trim();
    if (!expression) return;

    if (!watchedExpressions.some((watch) => watch.expression === expression)) {
      watchedExpressions.push({
        id: ++nextWatchId,
        expression,
        lastEvaluatedPauseVersion: 0,
        state: "unavailable",
        loadedNodes: new Map(),
        expandedPaths: new Set(),
        pendingPaths: new Set(),
        nodeErrors: new Map(),
      });
    }
    watchInput.value = "";
    renderWatchList();
    if (isDebugPaused) {
      void evaluatePendingWatches(pauseVersion);
    }
  });

  watchList.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const loadMoreButton = target.closest<HTMLElement>(
      "[data-watch-load-more]",
    );
    if (loadMoreButton) {
      const watchId = Number(loadMoreButton.dataset.watchLoadMore);
      const watch = watchedExpressions.find(
        (candidate) => candidate.id === watchId,
      );
      const path = readWatchPathAttribute(loadMoreButton.dataset.watchPath);
      const offset = Number(loadMoreButton.dataset.watchOffset);
      if (!watch || !path || !Number.isSafeInteger(offset) || offset < 0) {
        return;
      }

      void loadWatchNode(watch, path, offset);
      return;
    }

    const expandButton = target.closest<HTMLElement>("[data-watch-expand]");
    if (expandButton) {
      const watchId = Number(expandButton.dataset.watchExpand);
      const watch = watchedExpressions.find(
        (candidate) => candidate.id === watchId,
      );
      const path = readWatchPathAttribute(expandButton.dataset.watchPath);
      if (!watch || !path) return;

      void toggleWatchNode(watch, path);
      return;
    }

    const removeButton = target.closest<HTMLElement>("[data-watch-id]");
    if (!removeButton) return;

    const watchId = Number(removeButton.dataset.watchId);
    const watchIndex = watchedExpressions.findIndex(
      (watch) => watch.id === watchId,
    );
    if (watchIndex === -1) return;

    watchedExpressions.splice(watchIndex, 1);
    renderWatchList();
  });

  callStackList.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (target.closest("[data-call-stack-internal-toggle]")) {
      isShowingInternalCallStackFrames = !isShowingInternalCallStackFrames;
      renderCallStack();
      return;
    }

    const frameButton = target.closest<HTMLElement>(
      "[data-call-stack-source-frame]",
    );
    if (!frameButton) return;

    const frameIndex = Number(frameButton.dataset.callStackSourceFrame);
    const frame = callStack[frameIndex];
    if (frame?.kind !== "generated") return;

    focusCompiledSource(frame);
  });

  Object.values(sourceEditors).forEach((editor) => {
    editor.on("change", () => {
      sourceVersion += 1;
      updateRunButton();
    });
  });

  editors.compiledQuery.editor.on("gutterClick", (_, line, gutter) => {
    if (gutter !== "breakpoints") return;

    const sourceLine = line + 1;
    const breakpointIds = breakpointIdsByLine.get(sourceLine);
    if (!breakpointIds?.length) return;

    const hasActiveBreakpoint = breakpointIds.some((id) =>
      activeBreakpointIds.has(id),
    );
    if (!hasActiveBreakpoint) {
      // A line can contain many nested expressions. Start with its first
      // source-position candidate, then expose each exact position for the
      // user to opt into further pauses.
      activeBreakpointIds.add(breakpointIds[0]);
      expandedBreakpointLine = sourceLine;
    } else if (expandedBreakpointLine === sourceLine) {
      breakpointIds.forEach((id) => activeBreakpointIds.delete(id));
      expandedBreakpointLine = undefined;
    } else {
      expandedBreakpointLine = sourceLine;
    }

    renderBreakpoints();
  });

  editors.compiledQuery.editor
    .getWrapperElement()
    .addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const marker = target.closest<HTMLElement>("[data-breakpoint-id]");
      if (!marker) return;

      const breakpointId = Number(marker.dataset.breakpointId);
      if (!breakpointLocationsById.has(breakpointId)) return;

      event.preventDefault();
      event.stopPropagation();
      toggleInlineBreakpoint(breakpointId);
    });

  editors.compiledQuery.editor
    .getWrapperElement()
    .addEventListener("mousemove", (event) => {
      const identifier = getHoveredIdentifier(event);
      if (!identifier) {
        clearIdentifierHover();
        return;
      }

      if (hoveredIdentifier?.key === identifier.key) return;

      clearIdentifierHover();
      hoveredIdentifier = identifier;
      hoveredIdentifierMarker = editors.compiledQuery.editor.markText(
        identifier.start,
        identifier.end,
        { className: "debug-hovered-identifier" },
      );
      hoverTimer = window.setTimeout(() => {
        hoverTimer = undefined;
        void inspectHoveredIdentifier(identifier);
      }, 175);
    });

  editors.compiledQuery.editor
    .getWrapperElement()
    .addEventListener("mouseleave", clearIdentifierHover);
  editors.compiledQuery.editor.on("scroll", clearIdentifierHover);

  editors.compiledQuery.editor
    .getWrapperElement()
    .addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;

      const target = event.target;
      if (!(target instanceof Element)) return;

      const marker = target.closest<HTMLElement>("[data-breakpoint-id]");
      if (!marker) return;

      const breakpointId = Number(marker.dataset.breakpointId);
      if (!breakpointLocationsById.has(breakpointId)) return;

      event.preventDefault();
      event.stopPropagation();
      toggleInlineBreakpoint(breakpointId);
    });

  onDebugPause(({ breakpointId, reason, stack }) => {
    const line = findLineForBreakpoint(breakpointId);
    const action = reason === "step" ? "Stepped" : "Paused";
    const breakpointIds = line ? (breakpointIdsByLine.get(line) ?? []) : [];
    const occurrence = breakpointIds.indexOf(breakpointId) + 1;
    const occurrenceLabel =
      breakpointIds.length > 1
        ? ` (${occurrence}/${breakpointIds.length})`
        : "";
    setDebugPaused(
      true,
      `${action} on line ${line ?? "?"}${occurrenceLabel}`,
      line,
      breakpointId,
      stack,
    );
  });

  continueButton.addEventListener("click", () => {
    setDebugPaused(false);
    resumeDebug("continue");
  });

  runToCompletionButton.addEventListener("click", () => {
    setDebugPaused(false);
    resumeDebug("run-to-completion");
  });

  stepButton.addEventListener("click", () => {
    setDebugPaused(false);
    resumeDebug("step");
  });

  clearBreakpointsButton.addEventListener("click", () => {
    activeBreakpointIds.clear();
    expandedBreakpointLine = undefined;
    pausedBreakpointId = undefined;
    renderBreakpoints();
  });

  compileButton.addEventListener("click", async () => {
    const versionBeingCompiled = sourceVersion;
    compileButton.disabled = true;
    compileButton.dataset.state = "compiling";
    compileButton.setAttribute("aria-busy", "true");
    compileButton.setAttribute("aria-label", "Compiling query");
    compileButton.title = "Compiling query";
    compiledSourceVersion = undefined;
    compiledQuerySource = "";
    setDebugPaused(false);
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
      compiledQuerySource = reply.compiledQuery;
      setBreakpointLocations(reply.breakpoints);
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
      compiledQuerySource = error.message + "\n" + error.stack;
      setBreakpointLocations([]);
    } finally {
      compileButton.disabled = false;
      delete compileButton.dataset.state;
      compileButton.removeAttribute("aria-busy");
      compileButton.setAttribute("aria-label", "Compile query");
      compileButton.title = "Compile query";
      updateRunButton();
    }
  });

  runButton.addEventListener("click", async () => {
    if (compiledSourceVersion !== sourceVersion) return;

    isRunning = true;
    setDebugPaused(false);
    editors.exectionResult.editor.getDoc().setValue("");
    compileButton.disabled = true;
    runButton.dataset.state = "running";
    runButton.setAttribute("aria-busy", "true");
    runButton.setAttribute("aria-label", "Running compiled query");
    updateRunButton();

    try {
      const reply = await runCompiledQuery(getActiveBreakpointIds());
      editors.exectionResult.editor.getDoc().setValue(reply.executionResult);
    } catch (e) {
      compiledSourceVersion = undefined;
      const error = e instanceof Error ? e : new Error(String(e));
      editors.exectionResult.editor
        .getDoc()
        .setValue(error.message + "\n" + error.stack);
    } finally {
      isRunning = false;
      setDebugPaused(false);
      compileButton.disabled = false;
      delete runButton.dataset.state;
      runButton.removeAttribute("aria-busy");
      runButton.setAttribute("aria-label", "Run compiled query");
      updateRunButton();
    }
  });

  (window as any).editors = editors;

  function makeCollapsibleSection(
    id: string,
    editor?: Codemirror.Editor,
  ): CollapsibleSection {
    const button = $<HTMLButtonElement>(`${id}-trigger`);
    return {
      button,
      panel: $<HTMLElement>(`${id}-panel`),
      accordion: button.closest<HTMLElement>(".editor-accordion")!,
      editor,
    };
  }

  function syncSourceLayout() {
    const isMobile = sourceEditorBreakpoint.matches;

    workspaceEditors.forEach((editor) => {
      editor.setOption("viewportMargin", isMobile ? Infinity : 10);
      editor.setSize(null, isMobile ? "auto" : "100%");
    });

    if (isMobile) {
      collapsibleSections.forEach((section) => {
        section.button.disabled = true;
        setCollapsibleSectionExpanded(section, true);
      });
      requestAnimationFrame(() => {
        workspaceEditors.forEach((editor) => editor.refresh());
      });
      return;
    }

    collapsibleSections.forEach((section) => {
      section.button.disabled = false;
      if (
        section.editor &&
        section.accordion.classList.contains("is-expanded")
      ) {
        requestAnimationFrame(() => section.editor!.refresh());
      }
    });
  }

  function setCollapsibleSectionExpanded(
    section: CollapsibleSection,
    isExpanded: boolean,
  ) {
    section.button.setAttribute("aria-expanded", String(isExpanded));
    section.accordion.classList.toggle("is-expanded", isExpanded);
    section.panel.hidden = !isExpanded;

    if (isExpanded && section.editor) {
      requestAnimationFrame(() => section.editor!.refresh());
    }
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

  function makeHoverTooltip() {
    const tooltip = document.createElement("output");
    tooltip.className = "debug-hover-tooltip";
    tooltip.hidden = true;
    tooltip.setAttribute("role", "tooltip");
    document.body.append(tooltip);
    return tooltip;
  }

  function getHoveredIdentifier(event: MouseEvent) {
    if (!isDebugPaused) return undefined;

    const target = event.target;
    if (
      !(target instanceof Element) ||
      !target.closest(".CodeMirror-code") ||
      target.closest("[data-breakpoint-id]")
    ) {
      return undefined;
    }

    const editor = editors.compiledQuery.editor;
    const position = editor.coordsChar(
      { left: event.clientX, top: event.clientY },
      "window",
    );
    const token = editor.getTokenAt(position);
    if (
      position.ch < token.start ||
      position.ch >= token.end ||
      !isHoverableIdentifier(token.string)
    ) {
      return undefined;
    }
    const tokenStart = editor
      .getDoc()
      .indexFromPos({ line: position.line, ch: token.start });
    const tokenEnd = editor
      .getDoc()
      .indexFromPos({ line: position.line, ch: token.end });
    const expression = getHoverExpression(
      compiledQuerySource,
      tokenStart,
      tokenEnd,
    );
    if (isObjectKey(compiledQuerySource, tokenEnd)) return undefined;

    return {
      expression,
      key: `${position.line}:${token.start}:${token.end}:${expression}`,
      start: { line: position.line, ch: token.start },
      end: { line: position.line, ch: token.end },
    };
  }

  async function inspectHoveredIdentifier(identifier: HoveredIdentifier) {
    if (!isDebugPaused || hoveredIdentifier?.key !== identifier.key) return;

    const currentPauseVersion = pauseVersion;
    showHoverTooltip(
      identifier.start,
      identifier.end,
      "Inspecting…",
      "is-pending",
    );
    try {
      const reply = await evaluateDebugHover(identifier.expression);
      if (
        !isDebugPaused ||
        pauseVersion !== currentPauseVersion ||
        hoveredIdentifier?.key !== identifier.key
      ) {
        return;
      }

      showHoverTooltip(
        identifier.start,
        identifier.end,
        reply.notInScope
          ? "Not in scope"
          : (reply.error ?? reply.result ?? "undefined"),
        reply.notInScope ? "is-unavailable" : reply.error ? "is-error" : "",
      );
    } catch (error) {
      if (
        isDebugPaused &&
        pauseVersion === currentPauseVersion &&
        hoveredIdentifier?.key === identifier.key
      ) {
        showHoverTooltip(
          identifier.start,
          identifier.end,
          error instanceof Error ? error.message : String(error),
          "is-error",
        );
      }
    }
  }

  function showHoverTooltip(
    start: Codemirror.Position,
    end: Codemirror.Position,
    text: string,
    state: "" | "is-error" | "is-pending" | "is-unavailable",
  ) {
    const startCoordinates = editors.compiledQuery.editor.charCoords(
      start,
      "window",
    );
    const endCoordinates = editors.compiledQuery.editor.charCoords(
      end,
      "window",
    );
    hoverTooltip.className = ["debug-hover-tooltip", state]
      .filter(Boolean)
      .join(" ");
    hoverTooltip.textContent = text;
    hoverTooltip.hidden = false;
    hoverTooltip.style.left = `${(startCoordinates.left + endCoordinates.right) / 2}px`;
    hoverTooltip.style.top = `${startCoordinates.top - 6}px`;
    hoverTooltip.dataset.placement = "above";

    const bounds = hoverTooltip.getBoundingClientRect();
    if (bounds.top < 8) {
      hoverTooltip.style.top = `${endCoordinates.bottom + 6}px`;
      hoverTooltip.dataset.placement = "below";
    }
  }

  function clearIdentifierHover() {
    if (hoverTimer !== undefined) {
      window.clearTimeout(hoverTimer);
      hoverTimer = undefined;
    }
    hoveredIdentifier = undefined;
    hoveredIdentifierMarker?.clear();
    hoveredIdentifierMarker = undefined;
    hoverTooltip.hidden = true;
  }

  function setBreakpointLocations(breakpointLocations: BreakpointLocation[]) {
    const previouslyActiveLocations = Array.from(activeBreakpointIds)
      .map((id) => breakpointLocationsById.get(id))
      .filter(
        (location): location is BreakpointLocation => location !== undefined,
      )
      .map(breakpointLocationKey);

    breakpointIdsByLine = new Map();
    breakpointLocationsById = new Map();

    breakpointLocations.forEach((location) => {
      const { id, line } = location;
      const ids = breakpointIdsByLine.get(line) ?? [];
      ids.push(id);
      breakpointIdsByLine.set(line, ids);
      breakpointLocationsById.set(id, location);
    });

    breakpointIdsByLine.forEach((ids) =>
      ids.sort(
        (left, right) =>
          breakpointLocationsById.get(left)!.column -
          breakpointLocationsById.get(right)!.column,
      ),
    );

    const activeLocationKeys = new Set(previouslyActiveLocations);
    activeBreakpointIds = new Set(
      breakpointLocations
        .filter((location) =>
          activeLocationKeys.has(breakpointLocationKey(location)),
        )
        .map(({ id }) => id),
    );

    if (
      expandedBreakpointLine !== undefined &&
      !breakpointIdsByLine.has(expandedBreakpointLine)
    ) {
      expandedBreakpointLine = undefined;
    }
    pausedBreakpointId = undefined;
    renderBreakpoints();
  }

  function renderBreakpoints() {
    const editor = editors.compiledQuery.editor;
    editor.clearGutter("breakpoints");

    breakpointIdsByLine.forEach((ids, line) => {
      const isActive = ids.some((id) => activeBreakpointIds.has(id));
      const marker = document.createElement("span");
      marker.className = isActive
        ? "breakpoint-marker is-active"
        : "breakpoint-marker";
      marker.title = isActive
        ? "Show or remove breakpoints on this line"
        : "Add the first breakpoint on this line";
      editor.setGutterMarker(line - 1, "breakpoints", marker);
    });

    renderInlineBreakpoints();
    updateClearBreakpointsButton();
  }

  function updateClearBreakpointsButton() {
    const hasBreakpoints = activeBreakpointIds.size > 0;
    clearBreakpointsButton.disabled = !hasBreakpoints || isRunning;
    clearBreakpointsButton.title = isRunning
      ? "Breakpoints cannot be changed while execution is running"
      : hasBreakpoints
        ? "Clear all breakpoints"
        : "No breakpoints to clear";
  }

  function getActiveBreakpointIds() {
    return Array.from(activeBreakpointIds);
  }

  function findLineForBreakpoint(breakpointId: number) {
    return breakpointLocationsById.get(breakpointId)?.line;
  }

  function breakpointLocationKey(location: BreakpointLocation) {
    return `${location.line}:${location.column}:${location.endLine}:${location.endColumn}`;
  }

  function toggleInlineBreakpoint(breakpointId: number) {
    const location = breakpointLocationsById.get(breakpointId);
    if (!location) return;

    if (activeBreakpointIds.has(breakpointId)) {
      activeBreakpointIds.delete(breakpointId);
    } else {
      activeBreakpointIds.add(breakpointId);
    }
    expandedBreakpointLine = hasActiveBreakpointOnLine(location.line)
      ? location.line
      : undefined;
    renderBreakpoints();
  }

  function renderInlineBreakpoints() {
    inlineBreakpointMarkers.forEach((marker) => marker.clear());
    inlineBreakpointMarkers = [];

    const editor = editors.compiledQuery.editor;
    const inlineLocations = Array.from(breakpointLocationsById.values())
      .filter(
        (location) =>
          // Selected breakpoints remain visible wherever they occur. The
          // expanded line also shows its unselected candidates, which keeps
          // the rest of the source free from unnecessary controls.
          activeBreakpointIds.has(location.id) ||
          location.line === expandedBreakpointLine,
      )
      .sort(
        (left, right) => left.line - right.line || left.column - right.column,
      );

    inlineLocations.forEach((location) => {
      const { id } = location;

      const marker = document.createElement("button");
      const isActive = activeBreakpointIds.has(id);
      const isPaused = pausedBreakpointId === id;
      marker.type = "button";
      marker.className = [
        "inline-breakpoint-marker",
        isActive ? "is-active" : "",
        isPaused ? "is-paused" : "",
      ]
        .filter(Boolean)
        .join(" ");
      marker.dataset.breakpointId = String(id);
      marker.title = isActive ? "Remove breakpoint" : "Add breakpoint";
      marker.setAttribute(
        "aria-label",
        `${isActive ? "Remove" : "Add"} breakpoint at line ${location.line}, column ${location.column + 1}`,
      );

      inlineBreakpointMarkers.push(
        editor.setBookmark(
          { line: location.line - 1, ch: location.column },
          { widget: marker, insertLeft: true },
        ),
      );
    });
  }

  function hasActiveBreakpointOnLine(line: number) {
    return (breakpointIdsByLine.get(line) ?? []).some((id) =>
      activeBreakpointIds.has(id),
    );
  }

  async function evaluatePendingWatches(currentPauseVersion: number) {
    if (isEvaluatingWatches || !isDebugPaused) return;

    isEvaluatingWatches = true;
    try {
      while (isDebugPaused && pauseVersion === currentPauseVersion) {
        const watch = watchedExpressions.find(
          (candidate) =>
            candidate.lastEvaluatedPauseVersion !== currentPauseVersion,
        );
        if (!watch) return;

        watch.lastEvaluatedPauseVersion = currentPauseVersion;
        watch.state = "pending";
        renderWatchList();

        try {
          const reply = await evaluateDebugWatch(watch.expression, watch.id);
          if (
            !isDebugPaused ||
            pauseVersion !== currentPauseVersion ||
            !watchedExpressions.includes(watch)
          ) {
            continue;
          }

          watch.state = reply.error === undefined ? "value" : "error";
          watch.result = reply.error;
          watch.value = reply.value;
          watch.loadedNodes.clear();
          watch.expandedPaths.clear();
          watch.pendingPaths.clear();
          watch.nodeErrors.clear();
          if (watch.value?.expandable && watch.value.children) {
            watch.expandedPaths.add(getWatchPathKey([]));
          }
        } catch (error) {
          if (
            !isDebugPaused ||
            pauseVersion !== currentPauseVersion ||
            !watchedExpressions.includes(watch)
          ) {
            continue;
          }

          watch.state = "error";
          watch.result = error instanceof Error ? error.message : String(error);
        }
        renderWatchList();
      }
    } finally {
      isEvaluatingWatches = false;
      if (
        isDebugPaused &&
        pauseVersion === currentPauseVersion &&
        watchedExpressions.some(
          (watch) => watch.lastEvaluatedPauseVersion !== currentPauseVersion,
        )
      ) {
        void evaluatePendingWatches(currentPauseVersion);
      }
    }
  }

  function renderWatchList() {
    watchList.replaceChildren();
    if (watchedExpressions.length === 0) {
      const empty = document.createElement("li");
      empty.className = "debug-inspector-empty";
      empty.textContent = "Add an expression to inspect it at a breakpoint.";
      watchList.append(empty);
      return;
    }

    watchedExpressions.forEach((watch) => {
      const item = document.createElement("li");
      item.className = "watch-entry";

      const expression = document.createElement("code");
      expression.className = "watch-expression";
      expression.textContent = watch.expression;

      const remove = document.createElement("button");
      remove.className = "watch-remove-button";
      remove.type = "button";
      remove.dataset.watchId = String(watch.id);
      remove.setAttribute("aria-label", `Remove watch: ${watch.expression}`);
      remove.title = "Remove watch";
      remove.textContent = "×";

      const row = document.createElement("div");
      row.className = "watch-entry-row";
      row.append(expression, remove);

      const result = document.createElement("output");
      result.className = `watch-result is-${isDebugPaused ? watch.state : "unavailable"}`;
      const resultText = getWatchResultText(watch);
      result.textContent = resultText;

      const value = document.createElement("div");
      value.className = "watch-value";
      const rootIsExpandable =
        isDebugPaused && watch.state === "value" && watch.value?.expandable;
      const rootIsExpanded = watch.expandedPaths.has(getWatchPathKey([]));
      if (rootIsExpandable) {
        const toggle = document.createElement("button");
        toggle.className = "watch-tree-toggle";
        toggle.type = "button";
        toggle.dataset.watchExpand = String(watch.id);
        toggle.dataset.watchPath = "[]";
        toggle.setAttribute("aria-expanded", String(rootIsExpanded));
        toggle.setAttribute(
          "aria-label",
          `${rootIsExpanded ? "Collapse" : "Expand"} ${watch.expression}`,
        );
        toggle.title = rootIsExpanded ? "Collapse value" : "Expand value";
        toggle.textContent = rootIsExpanded ? "▾" : "▸";
        value.append(toggle, result);
      } else {
        value.append("= ", result);
      }

      item.append(row, value);
      if (
        isDebugPaused &&
        watch.state === "value" &&
        watch.value?.expandable &&
        watch.value.children &&
        rootIsExpanded
      ) {
        const tree = renderWatchChildren(watch, watch.value.children, []);
        if (watch.value.hasMore) {
          tree.append(
            renderWatchLoadMoreButton(watch, [], watch.value.children.length),
          );
        }
        item.append(tree);
      }
      watchList.append(item);
    });
  }

  function getWatchResultText(watch: WatchedExpression) {
    if (!isDebugPaused) return "not available";
    if (watch.state === "pending") return "evaluating…";
    if (watch.state === "error") return watch.result ?? "not available";
    return watch.value?.label ?? "not available";
  }

  function renderWatchChildren(
    watch: WatchedExpression,
    properties: readonly { key: string; value: DebugWatchValue }[],
    parentPath: string[],
  ) {
    const tree = document.createElement("ul");
    tree.className = "watch-tree";

    if (properties.length === 0) {
      const empty = document.createElement("li");
      empty.className = "watch-tree-empty";
      empty.textContent = "(empty)";
      tree.append(empty);
    }

    properties.forEach((property) => {
      const path = [...parentPath, property.key];
      const pathKey = getWatchPathKey(path);
      const loadedValue = watch.loadedNodes.get(pathKey);
      const displayValue = loadedValue ?? property.value;
      const isExpandable = displayValue.expandable === true;
      const isExpanded = watch.expandedPaths.has(pathKey);
      const isPending = watch.pendingPaths.has(pathKey);
      const item = document.createElement("li");
      item.className = "watch-tree-node";

      const row = document.createElement("div");
      row.className = "watch-tree-row";
      if (isExpandable) {
        const toggle = document.createElement("button");
        toggle.className = "watch-tree-toggle";
        toggle.type = "button";
        toggle.dataset.watchExpand = String(watch.id);
        toggle.dataset.watchPath = JSON.stringify(path);
        toggle.setAttribute("aria-expanded", String(isExpanded));
        toggle.setAttribute(
          "aria-label",
          `${isExpanded ? "Collapse" : "Expand"} ${property.key}`,
        );
        toggle.title = isExpanded ? "Collapse value" : "Expand value";
        toggle.textContent = isExpanded ? "▾" : "▸";
        row.append(toggle);
      } else {
        const indent = document.createElement("span");
        indent.className = "watch-tree-indent";
        indent.setAttribute("aria-hidden", "true");
        row.append(indent);
      }

      const key = document.createElement("code");
      key.className = "watch-tree-key";
      key.textContent = property.key;

      const separator = document.createElement("span");
      separator.className = "watch-tree-separator";
      separator.textContent = ":";

      const preview = document.createElement("output");
      preview.className = `watch-tree-preview is-${displayValue.type}`;
      preview.textContent = displayValue.label;
      row.append(key, separator, preview);
      item.append(row);

      if (isPending) {
        const loading = document.createElement("div");
        loading.className = "watch-tree-loading";
        loading.textContent = "Loading…";
        item.append(loading);
      } else if (
        isExpanded &&
        displayValue.expandable &&
        displayValue.children
      ) {
        const children = renderWatchChildren(
          watch,
          displayValue.children,
          path,
        );
        if (displayValue.hasMore) {
          children.append(
            renderWatchLoadMoreButton(
              watch,
              path,
              displayValue.children.length,
            ),
          );
        }
        item.append(children);
      } else if (watch.nodeErrors.has(pathKey)) {
        const error = document.createElement("div");
        error.className = "watch-tree-error";
        error.textContent = watch.nodeErrors.get(pathKey)!;
        item.append(error);
      }

      tree.append(item);
    });

    return tree;
  }

  function renderWatchLoadMoreButton(
    watch: WatchedExpression,
    path: string[],
    offset: number,
  ) {
    const item = document.createElement("li");
    item.className = "watch-tree-load-more";

    const button = document.createElement("button");
    button.className = "watch-tree-load-more-button";
    button.type = "button";
    button.dataset.watchLoadMore = String(watch.id);
    button.dataset.watchPath = JSON.stringify(path);
    button.dataset.watchOffset = String(offset);
    button.textContent = "Show 32 more";
    button.setAttribute("aria-label", "Show 32 more properties");
    item.append(button);
    return item;
  }

  async function toggleWatchNode(watch: WatchedExpression, path: string[]) {
    if (!isDebugPaused || watch.state !== "value") return;

    const pathKey = getWatchPathKey(path);
    if (watch.expandedPaths.has(pathKey)) {
      watch.expandedPaths.delete(pathKey);
      renderWatchList();
      return;
    }

    if (path.length === 0 || watch.loadedNodes.has(pathKey)) {
      watch.expandedPaths.add(pathKey);
      renderWatchList();
      return;
    }

    if (watch.pendingPaths.has(pathKey)) return;

    void loadWatchNode(watch, path, 0);
  }

  async function loadWatchNode(
    watch: WatchedExpression,
    path: string[],
    offset: number,
  ) {
    if (!isDebugPaused || watch.state !== "value") return;

    const pathKey = getWatchPathKey(path);
    if (watch.pendingPaths.has(pathKey)) return;

    const currentPauseVersion = pauseVersion;
    watch.pendingPaths.add(pathKey);
    watch.nodeErrors.delete(pathKey);
    renderWatchList();
    try {
      const reply = await expandDebugWatch(watch.id, path, offset);
      if (
        !isDebugPaused ||
        pauseVersion !== currentPauseVersion ||
        !watchedExpressions.includes(watch)
      ) {
        return;
      }

      if (reply.error) {
        watch.nodeErrors.set(pathKey, reply.error);
      } else if (reply.value) {
        setLoadedWatchNode(watch, path, reply.value, offset);
        watch.expandedPaths.add(pathKey);
      } else {
        watch.nodeErrors.set(pathKey, "Value preview unavailable.");
      }
    } catch (error) {
      if (
        isDebugPaused &&
        pauseVersion === currentPauseVersion &&
        watchedExpressions.includes(watch)
      ) {
        watch.nodeErrors.set(
          pathKey,
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      watch.pendingPaths.delete(pathKey);
      if (
        isDebugPaused &&
        pauseVersion === currentPauseVersion &&
        watchedExpressions.includes(watch)
      ) {
        renderWatchList();
      }
    }
  }

  function setLoadedWatchNode(
    watch: WatchedExpression,
    path: string[],
    value: DebugWatchValue,
    offset: number,
  ) {
    const previous = getLoadedWatchNode(watch, path);
    const mergedValue =
      offset > 0 && previous?.expandable && value.expandable && value.children
        ? {
            ...value,
            children: [...(previous.children ?? []), ...value.children],
          }
        : value;

    if (path.length === 0) {
      watch.value = mergedValue;
    } else {
      watch.loadedNodes.set(getWatchPathKey(path), mergedValue);
    }
  }

  function getLoadedWatchNode(watch: WatchedExpression, path: string[]) {
    if (path.length === 0) return watch.value;
    return watch.loadedNodes.get(getWatchPathKey(path));
  }

  function renderCallStack() {
    callStackList.replaceChildren();
    if (!isDebugPaused || callStack.length === 0) {
      const empty = document.createElement("li");
      empty.className = "debug-inspector-empty";
      empty.textContent = isDebugPaused
        ? "Call stack unavailable at this checkpoint."
        : "Pause at a breakpoint to inspect the call stack.";
      callStackList.append(empty);
      return;
    }

    const internalFrames = callStack.filter(
      (frame) => frame.kind === "internal",
    );
    const frames = isShowingInternalCallStackFrames
      ? callStack
      : callStack.filter((frame) => frame.kind !== "internal");

    frames.forEach((frame, visibleIndex) => {
      const item = document.createElement("li");
      item.className = "call-stack-frame";
      item.title = frame.raw;

      const number = document.createElement("span");
      number.className = "call-stack-frame-number";
      number.textContent = String(visibleIndex + 1);

      const label = document.createElement("span");
      label.className = "call-stack-frame-label";
      label.textContent = getCallStackFrameLabel(frame);

      const location = document.createElement("code");
      location.className = "call-stack-frame-location";
      location.textContent = formatCallStackLocation(frame);

      if (frame.kind === "generated") {
        const sourceButton = document.createElement("button");
        sourceButton.className = "call-stack-source-link";
        sourceButton.type = "button";
        sourceButton.dataset.callStackSourceFrame = String(
          callStack.indexOf(frame),
        );
        sourceButton.title = "Focus this location in the compiled query";
        sourceButton.append(label, location);
        item.append(number, sourceButton);
      } else {
        const description = document.createElement("span");
        description.className = "call-stack-frame-description";
        description.append(label, location);
        item.append(number, description);
      }
      callStackList.append(item);
    });

    if (internalFrames.length > 0) {
      const item = document.createElement("li");
      item.className = "call-stack-internal";

      const toggle = document.createElement("button");
      toggle.className = "call-stack-internal-toggle";
      toggle.type = "button";
      toggle.dataset.callStackInternalToggle = "";
      toggle.setAttribute(
        "aria-expanded",
        String(isShowingInternalCallStackFrames),
      );
      toggle.textContent = isShowingInternalCallStackFrames
        ? "Hide internal frames"
        : `Show ${internalFrames.length} internal frame${internalFrames.length === 1 ? "" : "s"}`;
      item.append(toggle);
      callStackList.append(item);
    }
  }

  function getCallStackFrames(
    stack: string | undefined,
    breakpointId?: number,
  ) {
    if (!stack) return [];

    const frames = stack
      .split("\n")
      .slice(1)
      .map((frame) => frame.trim())
      .filter(Boolean)
      .map(parseCallStackFrame);
    const breakpoint =
      breakpointId === undefined
        ? undefined
        : breakpointLocationsById.get(breakpointId);
    const pausedExpressionFrame = frames.find(
      (frame) => frame.kind === "generated" && frame.functionName === "eval",
    );
    const generatedLineOffset =
      breakpoint && pausedExpressionFrame?.line
        ? pausedExpressionFrame.line - breakpoint.line
        : 0;

    return frames.map((frame) => {
      if (frame.kind !== "generated") return frame;

      const isPausedExpression = frame === pausedExpressionFrame;
      return {
        ...frame,
        line:
          isPausedExpression && breakpoint
            ? breakpoint.line
            : frame.line
              ? Math.max(1, frame.line - generatedLineOffset)
              : undefined,
        // Checkpoint code occupies the raw error column. The breakpoint
        // metadata is the corresponding location in the source we display.
        column:
          isPausedExpression && breakpoint
            ? breakpoint.column + 1
            : frame.column,
      };
    });
  }

  function focusCompiledSource(frame: CallStackFrame) {
    if (frame.line === undefined) return;

    const editor = editors.compiledQuery.editor;
    const line = frame.line - 1;
    if (line < 0 || line >= editor.lineCount()) return;

    const sourceLine = editor.getLine(line);
    const column = Math.max(
      0,
      Math.min((frame.column ?? 1) - 1, sourceLine.length),
    );
    const position = { line, ch: column };
    editor.setCursor(position);
    editor.focus();
    editor.scrollIntoView(position, 100);
  }

  function setDebugPaused(
    isPaused: boolean,
    status = "",
    line?: number,
    breakpointId?: number,
    stack?: string,
  ) {
    clearIdentifierHover();
    isDebugPaused = isPaused;
    pauseVersion += 1;
    if (isPaused) {
      watchedExpressions.forEach((watch) => {
        watch.state = "unavailable";
        watch.result = undefined;
        watch.value = undefined;
        watch.loadedNodes.clear();
        watch.expandedPaths.clear();
        watch.pendingPaths.clear();
        watch.nodeErrors.clear();
      });
    }
    callStack = isPaused ? getCallStackFrames(stack, breakpointId) : [];
    isShowingInternalCallStackFrames = false;
    if (
      isPaused &&
      !hasOpenedDebugInspectors &&
      !sourceEditorBreakpoint.matches
    ) {
      setCollapsibleSectionExpanded(watchSection, true);
      setCollapsibleSectionExpanded(callStackSection, true);
      hasOpenedDebugInspectors = true;
    }
    pausedBreakpointId = isPaused ? breakpointId : undefined;
    if (isPaused && line !== undefined) {
      expandedBreakpointLine = line;
    }
    debugControls.hidden = !isPaused;
    runButton.hidden = isPaused;
    continueButton.disabled = !isPaused;
    runToCompletionButton.disabled = !isPaused;
    stepButton.disabled = !isPaused;
    debugStatus.hidden = !isPaused;
    debugStatus.textContent = status;
    setPausedLine(isPaused ? line : undefined);
    renderBreakpoints();
    renderWatchList();
    renderCallStack();
    if (isPaused) {
      void evaluatePendingWatches(pauseVersion);
    }
  }

  function setPausedLine(line: number | undefined) {
    const editor = editors.compiledQuery.editor;

    if (pausedLine !== undefined) {
      editor.removeLineClass(pausedLine - 1, "background", "debug-paused-line");
      editor.removeLineClass(pausedLine - 1, "gutter", "debug-paused-gutter");
    }

    pausedLine = line;
    if (line === undefined) return;

    editor.addLineClass(line - 1, "background", "debug-paused-line");
    editor.addLineClass(line - 1, "gutter", "debug-paused-gutter");
    editor.scrollIntoView({ line: line - 1, ch: 0 }, 100);
  }
}

type SourceEditor = "query" | "schema" | "resolvers";
type Theme = "dark" | "light";

interface CollapsibleSection {
  button: HTMLButtonElement;
  panel: HTMLElement;
  accordion: HTMLElement;
  editor?: Codemirror.Editor;
}

interface WatchedExpression {
  id: number;
  expression: string;
  lastEvaluatedPauseVersion: number;
  state: "error" | "pending" | "unavailable" | "value";
  result?: string;
  value?: DebugWatchValue;
  loadedNodes: Map<string, DebugWatchValue>;
  expandedPaths: Set<string>;
  pendingPaths: Set<string>;
  nodeErrors: Map<string, string>;
}

interface HoveredIdentifier {
  expression: string;
  key: string;
  start: Codemirror.Position;
  end: Codemirror.Position;
}

const JAVA_SCRIPT_KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "null",
  "of",
  "return",
  "static",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

function isHoverableIdentifier(value: string) {
  return /^[A-Za-z_$][\w$]*$/.test(value) && !JAVA_SCRIPT_KEYWORDS.has(value);
}

function isObjectKey(source: string, tokenEnd: number) {
  let cursor = tokenEnd;
  while (cursor < source.length && /\s/.test(source[cursor]!)) {
    cursor += 1;
  }
  return source[cursor] === ":";
}

/**
 * For a property in a plain member chain, evaluate the chain rather than the
 * property token alone. For example, hovering `callResolver` evaluates
 * `__context.rt.callResolver`, without ever including a following call.
 */
function getHoverExpression(
  source: string,
  tokenStart: number,
  tokenEnd: number,
) {
  let expressionStart = tokenStart;
  let cursor = skipWhitespaceBackward(source, tokenStart);
  if (source[cursor - 1] !== ".") {
    return source.slice(tokenStart, tokenEnd);
  }

  while (source[cursor - 1] === ".") {
    const beforeDot = skipWhitespaceBackward(source, cursor - 1);
    const identifierStart = findIdentifierStart(source, beforeDot);
    if (identifierStart === beforeDot) break;

    expressionStart = identifierStart;
    cursor = skipWhitespaceBackward(source, identifierStart);
  }

  return source.slice(expressionStart, tokenEnd);
}

function skipWhitespaceBackward(source: string, offset: number) {
  let cursor = offset;
  while (cursor > 0 && /\s/.test(source[cursor - 1]!)) {
    cursor -= 1;
  }
  return cursor;
}

function findIdentifierStart(source: string, offset: number) {
  let cursor = offset;
  while (cursor > 0 && /[A-Za-z0-9_$]/.test(source[cursor - 1]!)) {
    cursor -= 1;
  }
  return cursor;
}

function getWatchPathKey(path: string[]) {
  return JSON.stringify(path);
}

function readWatchPathAttribute(value: string | undefined) {
  if (!value) return undefined;

  try {
    const path = JSON.parse(value) as unknown;
    return Array.isArray(path) &&
      path.every((segment) => typeof segment === "string")
      ? path
      : undefined;
  } catch {
    return undefined;
  }
}

type CallStackFrameKind = "generated" | "internal" | "runtime";

interface CallStackFrame {
  raw: string;
  kind: CallStackFrameKind;
  functionName?: string;
  source?: string;
  line?: number;
  column?: number;
}

function parseCallStackFrame(raw: string): CallStackFrame {
  const frame = raw.replace(/^at\s+/, "");
  const chromeFrame = frame.match(/^(.*?)\s+\((.+):(\d+):(\d+)\)$/);
  const webKitOrFirefoxFrame = frame.match(/^(.*?)@(.+):(\d+):(\d+)$/);
  const anonymousFrame = frame.match(/^(.+):(\d+):(\d+)$/);
  const [, functionName, source, line, column] =
    chromeFrame ?? webKitOrFirefoxFrame ?? [];
  const [, anonymousSource, anonymousLine, anonymousColumn] =
    anonymousFrame ?? [];
  const locationSource = source ?? anonymousSource;
  const locationLine = line ?? anonymousLine;
  const locationColumn = column ?? anonymousColumn;

  return {
    raw,
    kind: getCallStackFrameKind(locationSource),
    functionName: functionName || undefined,
    source: locationSource,
    line: locationLine === undefined ? undefined : Number(locationLine),
    column: locationColumn === undefined ? undefined : Number(locationColumn),
  };
}

function getCallStackFrameKind(source: string | undefined): CallStackFrameKind {
  if (source?.startsWith("graphql-jit://")) return "generated";
  if (source?.includes("graphql-jit.js")) return "runtime";
  if (source?.startsWith(window.location.origin)) return "internal";
  return "runtime";
}

function getCallStackFrameLabel(frame: CallStackFrame) {
  if (frame.kind === "generated" && frame.functionName === "eval") {
    return "Paused expression";
  }
  return frame.functionName ?? "Anonymous";
}

function formatCallStackLocation(frame: CallStackFrame) {
  if (!frame.source) return frame.raw;

  let filename = frame.source;
  try {
    const { pathname } = new URL(frame.source);
    const pathSegments = pathname.split("/").filter(Boolean);
    filename = pathSegments[pathSegments.length - 1] ?? frame.source;
  } catch {
    // Preserve the source text if it is not a URL understood by the browser.
  }

  return frame.line === undefined
    ? filename
    : `${filename}:${frame.line}:${frame.column ?? "?"}`;
}

function readTheme(): Theme {
  return window.localStorage.getItem("theme") === "light" ? "light" : "dark";
}

function getValue(e: { editor: Codemirror.Editor }) {
  return e.editor.getValue();
}
