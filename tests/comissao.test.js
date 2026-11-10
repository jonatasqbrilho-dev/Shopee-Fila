import test from "node:test";
import assert from "node:assert/strict";
import { calcularComissaoUnidade, ordenarPorComissaoUnidade } from "../netlify/lib/comissao.js";

test("calcula comissão unitária usando preço vezes taxa decimal", () => {
  assert.equal(calcularComissaoUnidade(30, 0.2), 6);
  assert.equal(calcularComissaoUnidade(150, 0.1), 15);
  assert.equal(calcularComissaoUnidade(79.9, 0.15), 11.99);
});

test("não inventa comissão quando preço ou taxa são inválidos", () => {
  assert.equal(calcularComissaoUnidade(null, 0.2), null);
  assert.equal(calcularComissaoUnidade(30, null), null);
  assert.equal(calcularComissaoUnidade(-10, 0.2), null);
  assert.equal(calcularComissaoUnidade(30, -0.2), null);
  assert.equal(calcularComissaoUnidade("indisponível", 0.2), null);
});

test("ordena maior comissão primeiro e mantém dados ausentes no fim", () => {
  const produtos = [
    { item_id: "a", comissao_unidade: 6 },
    { item_id: "b", comissao_unidade: 15 },
    { item_id: "c", comissao_unidade: null },
    { item_id: "d", comissao_unidade: 12 }
  ];
  assert.deepEqual(ordenarPorComissaoUnidade(produtos).map(p => p.item_id), ["b", "d", "a", "c"]);
  assert.deepEqual(ordenarPorComissaoUnidade(produtos, "asc").map(p => p.item_id), ["a", "d", "b", "c"]);
});
