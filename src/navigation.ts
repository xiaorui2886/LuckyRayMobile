// Unified navigation (UI-REFRESH-R1) — truthful root navigation + bounded
// history.
//
// Model (revised for the UI refresh):
//  - 首页 (home) is a FIRST-CLASS bottom-nav destination, so the user can
//    always tell where they are and always has a one-tap way back;
//  - Bottom Nav destinations (home/library/capture/knowledge/settings) are
//    TOP-LEVEL ROOTS, not pushed history entries;
//  - the stack stays bounded: conceptually [root, overlay/details?] — 100
//    repeated tab switches never grow it;
//  - `switchRoot(tab)` REPLACES the top-level root (dropping any open
//    detail/search) instead of appending forever; reselecting the already
//    active root is a no-op;
//  - `pushDetail(route)` opens a detail layer under its owning root;
//  - `pushScreen(tab)` opens a full-screen page that is NOT a bottom-nav
//    destination (the desktop Agent surface), still bounded;
//  - `goHome()` returns to the 首页 root;
//  - Back semantics are deterministic and match Android convention:
//      overlay/detail -> owning root -> 首页 root -> system fallback.
//
// Navigation authority stays centralized here; screens never scatter ad-hoc
// history manipulation.

import { noteRouteIdentity } from "./noteRoute.ts";

export type Tab = "home" | "library" | "knowledge" | "capture" | "settings" | "search" | "ai";
export type Route = { tab: Tab; detail?: string };

/**
 * Bottom-nav destinations in visual order (DESIGN.md §6):
 *   首页 / 素材 / AI / 知识 / 我的
 *
 * `capture` is deliberately NOT here: the approved design makes Capture a
 * GLOBAL compose action above the bottom nav, not a root tab. It still exists
 * as a route (it is a pushed surface) and its own root state is reachable, but
 * `switchRoot("capture")` is no longer a nav destination.
 *
 * `ai` IS a destination in every connection state — unpaired must show the
 * Connect Computer guidance, never hide the tab.
 */
export const BOTTOM_NAV_TABS: readonly Tab[] = ["home", "library", "ai", "knowledge", "settings"];

/** Roots that show the global Capture action (DESIGN.md §6: hidden on
 *  detail/editor/sheet/full-screen media/pairing flows). */
export const FAB_ROOTS: readonly Tab[] = ["home", "library", "ai", "knowledge", "settings"];

export class NavigationController {
  private stack: Route[] = [];
  private listeners = new Set<() => void>();

  constructor(initial: Route = { tab: "home" }) {
    this.stack = [initial];
  }

  current(): Route {
    return this.stack[this.stack.length - 1];
  }

  /**
   * Read-only view of the whole stack (STILL-01.1 view layer). The Still
   * PageLayer presentation derives covered/buried layers from this; it never
   * mutates history — every mutation stays in this controller.
   */
  snapshot(): Route[] {
    return [...this.stack];
  }

  /** True when a dismissible layer (detail/search/agent) is on top. */
  hasLayer(): boolean {
    return this.stack.length > 1 && this.current().detail !== undefined ? true : this.stack.length > 1;
  }

  /**
   * Bottom Nav root switch: replaces the top-level root with `tab` and
   * discards any open detail/search layer. Reselecting the already-active
   * root is a no-op (never adds duplicate history).
   */
  switchRoot(tab: Tab): void {
    if (!BOTTOM_NAV_TABS.includes(tab)) return; // only real nav destinations
    const top = this.current();
    if (top.tab === tab && !top.detail) return; // already active: no-op
    this.stack = [{ tab }];
    this.notify();
  }

  /** Return to the 首页 root (header affordances, avatar, deep links). */
  goHome(): void {
    if (this.stack.length === 1 && this.current().tab === "home") return;
    this.stack = [{ tab: "home" }];
    this.notify();
  }

  /**
   * Open the Local Search overlay from the current root — a detail-like
   * layer, so Back returns to the initiating root, and a Bottom Nav switch
   * while it is open discards it.
   */
  openSearch(): void {
    const root = this.stack[this.stack.length - 1];
    if (root.detail) {
      this.stack.pop(); // replace any open detail layer
    }
    this.stack.push({ tab: "search" });
    this.notify();
  }

  /**
   * Detail-like push: opens the layer under its OWNING root. The stack bottom
   * is decided by what the caller is standing on:
   *
   *  - standing on Search → Search is an IMMEDIATE user-visible parent, so the
   *    result detail is pushed ON TOP of it: [root, search, detail]. Back then
   *    returns to the Search results the user came from (REPAIR-R1 P2-N1),
   *    instead of skipping to the root. Another result REPLACES the detail
   *    layer, so repeated opens never grow the stack.
   *  - `options.originRoot` given (any other root) → that INITIATING root is
   *    preserved: Home -> note -> Back = Home.
   *  - no `originRoot` → the detail's owning root replaces the bottom
   *    (deep-link style: an external open lands in its owner).
   *
   * Bounded everywhere: [root, detail] or [root, search, detail] — never a
   * second unbounded history.
   */
  pushDetail(route: Route & { detail: string }, options?: { originRoot?: Tab; retainDetail?: boolean }): void {
    if (this.stack.length === 0) {
      this.stack = [{ tab: "home" }];
    }
    // A note has one retained page/save owner, regardless of its entry mode.
    // Search also reveals a note already below the top instead of replacing
    // the top with a second copy. Preserve the original route/React key.
    const identity = route.tab === "knowledge" ? noteRouteIdentity(route.detail) : undefined;
    const existing = identity === undefined ? -1 : this.stack.findIndex((item, index) =>
      index > 0 && item.tab === "knowledge" && item.detail !== undefined
      && noteRouteIdentity(item.detail) === identity);
    if (existing >= 1) {
      const owner = this.stack[existing], parent = this.current();
      this.stack = parent.tab === "search"
        ? [...this.stack.slice(0, existing), parent, owner]
        : this.stack.slice(0, existing + 1);
      this.notify(); return;
    }
    // Inline note navigation opts into the SAME bounded history authority.
    // Retain the source layer/scroll; cycles reveal the existing identity.
    // New result/list targets keep their historical replacement behavior.
    if (options?.retainDetail && this.current().detail && this.current().tab === route.tab) {
      const previous = this.stack.findIndex(item => item.tab === route.tab && item.detail === route.detail);
      if (previous >= 1) this.stack = this.stack.slice(0, previous + 1);
      else {
        this.stack.push({ tab: route.tab, detail: route.detail });
        const details = this.stack.map((item, index) => item.detail ? index : -1).filter(index => index >= 0);
        if (details.length > 8) this.stack.splice(details[0], 1);
      }
      this.notify(); return;
    }
    // Replace an open detail layer at any depth (depth 1 normally, depth 2
    // when it sits on top of Search).
    if (this.current().detail) {
      this.stack.pop();
    }
    const current = this.current();
    if (current.tab === "search") {
      // Keep [.., search] and push the detail above it.
      this.stack.push({ tab: route.tab, detail: route.detail });
      this.notify();
      return;
    }
    if (current.tab !== route.tab) {
      this.stack = [{ tab: options?.originRoot ?? route.tab }];
    }
    this.stack.push({ tab: route.tab, detail: route.detail });
    this.notify();
  }

  /**
   * Full-screen page that is not a bottom-nav destination (Capture, the
   * desktop Agent surface). Pushed ON TOP of the initiating root so Back
   * returns to wherever the user actually was (INTERACTION-CLOSURE-R1):
   *   素材 → 收集 → Back = 素材
   *   知识 → 收集 → Back = 知识
   * The stack stays bounded: [root, pushedScreen] — pushing from a pushed
   * screen replaces it, never grows unbounded.
   */
  pushScreen(tab: Tab): void {
    const root = this.stack[0] ?? { tab: "home" as Tab };
    this.stack = [root, { tab }];
    this.notify();
  }

  /**
   * Back: pops a layer; a non-首页 root returns to 首页 (one step); at 首页
   * with no layer returns false so the system fallback (close) applies.
   */
  goBack(): boolean {
    if (this.stack.length > 1) {
      this.stack.pop();
      this.notify();
      return true;
    }
    if (this.current().tab !== "home") {
      this.stack = [{ tab: "home" }];
      this.notify();
      return true;
    }
    return false;
  }

  reset(route: Route): void {
    this.stack = [route];
    this.notify();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}

export const navigation = new NavigationController();
