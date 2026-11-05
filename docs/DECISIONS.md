# Locked decisions (from the product owner)

1. **Floating window:** Tauri v2, always-on-top, cross-platform (macOS/Windows/Linux).
   Coworkers get prebuilt binaries from GitHub Releases; nobody should need Rust to use it.
2. **Agent integration:** a Claude Code plugin ("mod"), shareable with anyone, not tied to any
   private framework. Install path: `/plugin install ttd --marketplace <owner>/<repo>`.
3. **Shared store:** one local file under `~/.ttd/` that both the window and the agent read/write.
   Losing an item is the core pain this tool exists to fix: writes must be atomic and conflict-safe.
4. **UI per `docs/mockup.png`:**
   - header "TTD" + `+` button; `+` opens an inline Title / Body form
   - list of todos; click to expand; expanded shows body, trash (delete), play (in progress), check (done)
   - drag to reorder
   - colors: grey = not started, blue = in progress, green = done
5. **In-progress control:** a play icon shown with trash and check on the expanded todo. Icon:
   `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path d="M6 3L20 12L6 21V3Z" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" stroke="currentColor"/></svg>`
   The agent can also set any status through its tools.
