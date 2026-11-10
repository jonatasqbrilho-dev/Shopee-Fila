import test from "node:test";
import assert from "node:assert/strict";
import { palavras, legendaSegura, palavraChaveProduto, validarGanchos, validarContinuidade } from "../netlify/diretor-validacao.js";

test("extrai palavra-chave apenas do nome do produto", () => {
  assert.equal(palavraChaveProduto("Kit de 3 Potes Herméticos para Cozinha"), "potes herméticos cozinha");
});

test("valida três ganchos distintos e mantém as três abordagens", () => {
  const hooks = validarGanchos([
    { texto: "Cansado de perder espaço?", abertura_visual: "Mostrar o armário desorganizado." },
    { texto: "Veja o detalhe que facilita a rotina", abertura_visual: "Aproximar a câmera da tampa." },
    { texto: "Olha como abre e fecha", abertura_visual: "Demonstrar a tampa em ação." }
  ]);
  assert.equal(hooks.length, 3);
  assert.deepEqual(hooks.map(x => x.tipo), ["Problema e solução", "Curiosidade", "Demonstração"]);
});

test("rejeita ganchos repetidos ou incompletos", () => {
  assert.throws(() => validarGanchos([
    { texto: "Veja isso", abertura_visual: "Mostrar produto." },
    { texto: "Veja isso", abertura_visual: "Mostrar tampa." },
    { texto: "Veja isso", abertura_visual: "Abrir produto." }
  ]), /diferentes/);
  assert.throws(() => validarGanchos([]), /completos/);
  assert.throws(() => validarGanchos([{texto:"uma frase com mais de doze palavras que deve ser rejeitada agora mesmo",abertura_visual:"Mostrar."},{texto:"Curiosidade",abertura_visual:"Aproximar."},{texto:"Demonstração",abertura_visual:"Abrir."}]), /12 palavras/);
});

test("remove preço, porcentagem e afirmações promocionais da legenda", () => {
  const clean = legendaSegura("Só R$ 29,90 com 50% de desconto! Produto para sua casa. #Casa");
  assert.doesNotMatch(clean, /R\$|50%|desconto/i);
  assert.ok(clean.length <= 150);
});

test("limita legenda a 150 caracteres", () => {
  assert.ok(legendaSegura("Produto útil ".repeat(30)).length <= 150);
});

test("limita fala por palavras", () => {
  assert.equal(palavras("Uma fala curta com produto e CTA").length, 7);
});

test("preenche continuidade para evitar mudanças entre tomadas", () => {
  const c = validarContinuidade({});
  assert.ok(c.pessoa && c.roupa && c.cenario && c.iluminacao && c.camera);
});
