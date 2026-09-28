import assert from "node:assert/strict";
import { test } from "node:test";
import { t, useLang } from "../web/i18n.ts";
import { TEXT } from "../web/i18n-text.ts";

test("every translation uses only the placeholders of its English text", () => {
  for (const [en, trs] of Object.entries(TEXT)) {
    const have = new Set(en.match(/\{\d\}/g) ?? []);
    for (const tr of trs) {
      assert.ok(tr.trim(), `empty translation for ${en}`);
      for (const p of tr.match(/\{\d\}/g) ?? []) assert.ok(have.has(p), `${JSON.stringify(tr)} uses ${p}, not in ${JSON.stringify(en)}`);
    }
  }
});

test("t() translates exact text and messages with variable parts, and leaves unknown text alone", () => {
  useLang("en");
  assert.equal(t("Save"), "Save");
  useLang("ko");
  assert.equal(t("Save"), "저장");
  assert.equal(t("  Save "), "  저장 ", "surrounding whitespace is kept");
  assert.equal(t("saved work/a.rig.json"), "work/a.rig.json 저장함");
  // placeholders may be reordered and English plural endings dropped
  assert.equal(t("Remove ParamA from face"), "face에서 ParamA 제거");
  assert.equal(t("3 bones selected"), "본 3개 선택됨");
  // the variable part is translated too when it is UI text; the match covering the most wins
  assert.equal(t("Tools · all vertices"), "도구 · 모든 정점");
  assert.equal(t("mesh · 18 vertices (18 on the outline) · 16 triangles · image arm"), "메시 · 정점 18 (외곽선 18) · 삼각형 16 · 이미지 arm");
  assert.equal(t("Live2D art mesh · 4 vertices · 2 polygons · 1 keyform · under WarpFace"), "Live2D 아트메시 · 정점 4 · 폴리곤 2 · 키폼 1 · 부모 WarpFace");
  assert.equal(t("neck-2"), "neck-2");
  useLang("ja");
  assert.equal(t("Mesh mode: click a mesh to pick the slot to edit"), "メッシュモード: メッシュをクリックして編集するスロットを選択");
  useLang("en");
});
