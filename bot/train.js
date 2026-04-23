const fs = require("fs");
const path = require("path");

const dataPath = path.join(__dirname, "training-data.json");
const outputPath = path.join(__dirname, "..", "bot-model.js");

const stopWords = new Set([
  "a",
  "an",
  "the",
  "is",
  "to",
  "for",
  "me",
  "my",
  "i",
  "it",
  "this",
  "please",
  "ke",
  "ki",
  "ka",
  "hai",
  "se",
  "ko"
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((token) => token && !stopWords.has(token));
}

function train(dataset) {
  const labels = {};
  const vocabulary = new Set();
  let totalDocs = 0;

  for (const intent of dataset.intents) {
    labels[intent.name] = {
      docs: intent.examples.length,
      totalTokens: 0,
      tokenCounts: {},
      reply: intent.reply
    };
    totalDocs += intent.examples.length;

    for (const example of intent.examples) {
      for (const token of tokenize(example)) {
        vocabulary.add(token);
        labels[intent.name].totalTokens += 1;
        labels[intent.name].tokenCounts[token] = (labels[intent.name].tokenCounts[token] || 0) + 1;
      }
    }
  }

  return {
    version: 1,
    trainedAt: new Date().toISOString(),
    totalDocs,
    vocabulary: [...vocabulary].sort(),
    labels
  };
}

const dataset = JSON.parse(fs.readFileSync(dataPath, "utf8"));
const model = train(dataset);
const file = `window.CALL_TICKET_BOT_MODEL = ${JSON.stringify(model, null, 2)};\n`;

fs.writeFileSync(outputPath, file);
console.log(`Trained ${Object.keys(model.labels).length} intents with ${model.vocabulary.length} tokens.`);
console.log(`Wrote ${path.relative(process.cwd(), outputPath)}`);
