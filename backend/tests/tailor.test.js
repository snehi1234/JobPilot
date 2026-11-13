import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeTailoring, buildTailorPrompt, droppedTech } from "../lib/tailor.js";

const RESUME = `Alex Example
Experience
• Built a payments ledger in Java and Kafka handling 2M events/day with 99.99% uptime
• Reduced p99 latency by 45% by redesigning the caching layer with Redis
• Worked on the partner onboarding API used by 300+ partners
Skills
Java, Kafka, Redis, Python, Kubernetes`;

test("only grounded bullet rewrites survive", () => {
  const out = sanitizeTailoring({
    summary: "Backend engineer who built a Kafka ledger handling 2M events/day.",
    bullets: [
      { original: "Built a payments ledger in Java and Kafka handling 2M events/day with 99.99% uptime",
        improved: "Engineered a real-time Kafka payments ledger in Java processing 2M events/day at 99.99% uptime", keywords: ["Kafka", "real-time"] },
      { original: "Reduced p99 latency by 45% by redesigning the caching layer with Redis",
        improved: "Cut p99 latency 60% with a Redis caching redesign" },
      { original: "Managed a team of 12 engineers", improved: "Led 12 engineers across 3 teams" },
      { original: "Worked on the partner onboarding API used by 300+ partners",
        improved: "Designed the partner onboarding API adopted by 300+ partners" },
      { original: "Worked on the partner onboarding API used by 300+ partners",
        improved: "Duplicate of the same line with other words entirely" },
    ],
    skills: ["Kafka", "Java", "Go", "Redis"],
    gaps: ["Go", "AWS"],
  }, RESUME);
  assert.equal(out.bullets.length, 2);
  assert.match(out.bullets[0].improved, /^Engineered/);
  assert.equal(out.bullets[0].line, "• Built a payments ledger in Java and Kafka handling 2M events/day with 99.99% uptime");
  assert.ok(!out.bullets.some((b) => /60%/.test(b.improved)), "new numbers are rejected");
  assert.ok(!out.bullets.some((b) => /12 engineers/.test(b.improved)), "bullets not on the resume are rejected");
  assert.equal(JSON.stringify(out.skills), JSON.stringify(["Kafka", "Java", "Redis"]), "skills not on the resume are dropped");
  assert.match(out.summary, /2M events/);
  assert.equal(JSON.stringify(out.gaps), JSON.stringify(["Go", "AWS"]));
  assert.equal(sanitizeTailoring({ summary: "Led 500 engineers" }, RESUME).summary, "", "summary with invented numbers is dropped");
  assert.equal(sanitizeTailoring(null, RESUME).bullets.length, 0);
});

test("tailor prompt carries the job and the honesty rules", () => {
  const p = buildTailorPrompt({ resume: RESUME, jobContext: { title: "Data Engineer", company: "Role @ Acme", description: "Spark and Kafka" } });
  assert.match(p, /Job title: Data Engineer/);
  assert.match(p, /Company: Acme/);
  assert.match(p, /copied EXACTLY/);
  assert.match(p, /Never add employers/);
});

test("rewrites that drop a named technology are rejected; whole wrapped bullets are used", () => {
  const resume = `Sam Sample
Experience
Example Corp — Jul 2023 – Aug 2024
●   Built core components of a secure financial platform   (C#, .NET Core 6, Python, Vue.js) for stock and fund - transfer
operations, designing the data - access layer for testability.
●   Designed the real - time order pipeline using RabbitMQ for multi - store order consolidation across stores.`;
  const raw = { bullets: [
    { original: "Built core components of a secure financial platform (C#, .NET Core 6, Python, Vue.js) for stock and fund-transfer operations",
      improved: "Engineered a secure financial transactions platform with a testable data-access layer for stock and fund transfers." },
    { original: "Built core components of a secure financial platform (C#, .NET Core 6, Python, Vue.js)",
      improved: "Engineered a secure financial platform in C#, .NET Core 6, Python, and Vue.js with a testable data-access layer for stock and fund transfers." },
    { original: "Designed the real-time order pipeline using RabbitMQ for multi-store order consolidation",
      improved: "Built an event-driven order-routing pipeline for multi-store consolidation." },
  ] };
  const out = sanitizeTailoring(raw, resume, { wholeBullets: true });
  assert.equal(out.bullets.length, 1);
  assert.match(out.bullets[0].improved, /C#, \.NET Core 6/);
  assert.match(out.bullets[0].line, /operations, designing the data - access layer for testability\.$/, "the whole bullet, not just its first line");
  // Older extension versions only replace single lines, so they get the first line.
  assert.match(sanitizeTailoring(raw, resume).bullets[0].line, /fund - transfer$/);
  assert.deepEqual(droppedTech("Used RabbitMQ and JWT on Azure (Python, C#, React, MySQL)", "Used RabbitMQ, JWT, Python, C#, React and MySQL"), []);
  assert.deepEqual(droppedTech("Built it in Python (Docker, Kubernetes, and Kafka)", "Built it with Docker and Kubernetes"), ["Kafka"]);
});
