# Awaken2D - notes for agents

- TypeScript runs directly on Node (type stripping). Only erasable syntax: no enums, namespaces, or constructor
  parameter properties. Relative imports must include the `.ts` extension; type-only imports use `import type`.
- No runtime dependencies. Keep it that way unless there is a strong reason.
- Checks: `npm test` (node:test) and `npm run typecheck`.
- All model mutations go through `applyOps` in `src/core/ops.ts`. New editing features = new op + docs row in
  `docs/FORMAT.md` (served to agents by `rig spec` / MCP `rig_spec`) + test.
- Coordinates: +y up, degrees CCW, mesh vertices in setup-pose world space.
- Visual check: `npm run rig -- sheet <model> --anim <name>` then open the PNG.
- Art import lives in `src/import` (PSD reader, layer import, skeleton proposal; layer meshes are planned per layer by
  `src/core/meshplan.ts`: role from name / shape, vertex budget, coverage check; `work/tools/meshplan-trial.ts` compares
  it with the grid on a PSD or PNG folder); it is reached through the CLI
  (`rig import`), MCP (`rig_import`) and build scripts only - the web editor has no import UI on purpose. `npm run example:psd` regenerates the
  demo PSD; there is no real Photoshop file in the repo, so test reader changes against varied PSDs when possible.
- Spine models are posed by `src/core/spine.ts`, a port of the Spine 4.3 runtime's update (inherit modes, IK /
  transform / path / physics / slider constraints in `constraintOrder`, skins); bezier eases on Spine models are
  sampled like the runtime (`easeValue(..., spine)`). Local tools compare with the official runtime (built into
  `work/spine-core-4.3`, gitignored, with the examples in `work/spine-examples`): `work/tools/spine-rt-compare.ts`,
  `spine-rt-bone.ts`, `spine-json-roundtrip.ts`. The editor's Spine tabs (Constraints, Skins, Events, Images) are
  in `web/spineui.ts`.
- Spine interop lives in `src/spine` (atlas.ts pure, import.ts / export.ts pure, index.ts file I/O).
  `tests/spine-reference.ts` evaluates Spine data by Spine's own rules (local, gitignored: `work/tools/spine-compare.ts`,
  `spine-roundtrip.ts` check a real export). Keep imported data exact: unedited attachments/deforms are re-emitted
  from `meta.spine` (guarded by signatures), so ops that change a mesh must replace the attachment object.
- Live2D interop lives in `src/live2d` (moc3.ts binary writer, import.ts / export.ts pure, index.ts file I/O;
  the user-facing import reads the Cubism Editor file: caff.ts container + cmo3.ts main.xml -> rig, can3.ts
  animation scenes -> motion3 -> animations; checked with `work/tools/cmo3-compare.ts <cmo3> <runtime moc3>` and
  `can3-compare.ts <cmo3> <can3> <motion folder>` against the runtime export of the same files; deformation paths
  (editing aid) are `src/core/live2dpath.ts`, curve checked by `work/tools/path-curve-check.ts`; runtime sets
  (model3 + moc3) are only written, never read);
  evaluation is core: `src/core/live2d.ts` (keyforms, deformers, glue, draw order), `live2dphysics.ts` (physics3,
  Cubism Framework step for step), `live2dpose.ts` (pose3 fades), `live2dops.ts` (edit ops). Keep it exact: the
  local tools `work/tools/live2d-compare.ts`, `live2d-fuzz.ts`, `live2d-motion-compare.ts` (gitignored) compare
  with the official Cubism Core / Framework (Core 6 from the Web SDK in `work/cubism-web-5r5`, loaded by
  `work/tools/cubism-core.cjs`; mao_pro in Downloads/mao_ko is the blend-shape reference), and
  `tests/live2d-golden*.json` hold their output for the fixture rigs (`-blend` for blend shapes).
  Live2D edits replace `model.live2d` / attachment objects (copy on write), like the other ops.
- Models have a `target` ("spine" | "live2d"): `checkTarget` in ops.ts refuses the other kind's ops, the editor hides
  them (`.spine-only` / `.live2d-only` classes on body[data-target], timeline track kinds). Every model has one
  (`emptyModel` defaults to spine; files saved without one load as live2d when they have a rig, else spine). The
  editor cannot create models (no New, no /api/new): agents do, with `rig_new` + target.
- Web editor: `src/web/server.ts` (HTTP API + SSE + undo history) and `web/` (browser code). Browser TS is served
  type-stripped; `node:fs`/`node:path` imports are rewritten to `web/shims/`. Keep core code browser-safe apart
  from those two modules. `window.awaken2d` exposes editor state for debugging.
- The editor server keeps a working copy per file: `/api/apply` does not write to disk unless auto-save is on
  (`serve --autosave`); `/api/save` does. Agents editing files via CLI/MCP write to disk directly, which the editor
  picks up (or flags as a conflict when the user has unsaved edits). UI popups use `web/dialog.ts`, never
  `prompt`/`confirm`/`alert`; paths (Import / Export / Save As) are picked, never typed: `path` dialog fields open
  `web/picker.ts` (server `/api/browse`, `/api/native-pick` for the Windows dialog, in `src/web/files.ts`); viewport gizmos live in `web/gizmo.ts`.
- Editor UI text is written in English in the code; `web/i18n.ts` translates the page (a MutationObserver over text
  nodes and title / placeholder / aria-label; canvas text goes through `t()`) from `web/i18n-text.ts`
  (English -> [Korean, Japanese], `{0}` for variable parts). New or changed UI strings need an entry there
  (`window.awaken2d.i18nMisses` lists untranslated text seen in the page). Data (names, ids, paths) goes in
  `translate="no"` elements (`raw()` in app.ts) so it is never translated.
- Editor performance: the client applies ops locally and sends `lean: true` (no model in the response); full
  validation (pose sampling with physics) runs in `src/web/validate-worker.ts` and arrives over SSE as `validated`.
  `applyOps` shares attachment objects for ops in `MESH_SAFE_OPS` (and `updateBone`), so ops must replace an
  attachment object, never mutate one in place. The frame loop skips drawing while idle; call `requestDraw()` if
  you change what the viewport shows outside input events or `applyInfo`.
