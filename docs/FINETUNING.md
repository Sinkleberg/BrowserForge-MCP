# Fine-tuning the local decider

`browser_run_goal` records every step it takes (and every DONE/BLOCKED) as a trace. Once you have labelled enough runs good, you can turn them into a LoRA fine-tune of the small model so it needs fewer retries and makes fewer mistakes on the sites you use. Nothing here is automatic and nothing leaves your machine unless you move the dataset yourself.

## 1. Collect

1. Run `browser_run_goal` on real tasks. Traces are written to `<config>/knowledge/traces.jsonl` (disable with `--no-traces`).
2. After you checked the outcome, label the run: `browser_goal_feedback { runId, outcome: "good" | "bad" }`. Bad runs are never reused or exported. A few hundred good steps across your sites is a sensible minimum; a handful will not change the model.
3. `knowledge_list` shows how many runs and labels you have.

### Your own demonstrations

The best examples are yours. With **Record me** on ([FLOWS.md](FLOWS.md)), each click, selection and typed field you make becomes a training step: the page's controls as the agent would see them just before, and the step you took (`TYPE` into row 3 using the parameter `first_name`, `CLICK` row 7...). They appear in `knowledge_list` under `byDecider.human` and are exported with the rest.

* No typed value is part of an example, only the name of the parameter it belongs to.
* A run is labelled **good automatically** when the page after your submit shows a confirmation (the label says `auto`); it is labelled bad when it shows an error. A demonstration whose ending BrowserForge could not read gets no label, so it is left out of the default `good` export. Label it with `browser_goal_feedback` (the run id starts with `h-`) or export with `minLabel: "any"`.
* A label from you or your agent always outranks the automatic one.
* Quantity matters more than variety of sites at first: 30 or more demonstrations of the same kind of form (job applications, say) on different sites teach the model more than two on each of 15 sites. A handful of examples will not change the model.

## 2. Export

```
knowledge_export_dataset { path: "<config>/exports/decider-train.jsonl" }              # good runs only (default)
knowledge_export_dataset { path: "...", include: "unlabelled" }                          # also unlabelled, never bad
```

Each line is `{"messages":[{"role":"system",...},{"role":"user",...},{"role":"assistant","content":"{\"op\":...}"}]}`, the chat format Unsloth, axolotl and TRL accept. It contains control labels and decisions, never the values you typed. Review the file before sharing it anywhere: labels can still contain names or other personal text.

The user message is the same prompt the runner builds, minus the page headings and the retrieved examples (neither is stored). The assistant message is the exact JSON the model must produce.

## 3. Train (on another machine or a rented GPU)

A 4 GB laptop GPU is too small to train these models. Use Colab, a rented GPU or a bigger machine. A typical QLoRA run with Unsloth on `Qwen/Qwen3-4B-Instruct` (or the base of whatever `--decider-model` you use): rank 16, 1 to 3 epochs, learning rate around 2e-4, train on the assistant tokens only. Keep a held-out slice of the data to compare against the base model.

## 4. Use it

Merge or export the adapter to GGUF, then give it to Ollama:

```
# Modelfile
FROM qwen3:4b-instruct
ADAPTER ./decider-lora.gguf
```
```
ollama create bf-decider -f Modelfile
browserforge serve --decider-model bf-decider
```

Compare on the demo form or one of your sites before switching: the e2e test `tests/e2e/goal.e2e.test.ts` accepts `BF_DECIDER_MODEL=bf-decider`. Keep the base model as the default if the tuned one is not clearly better; the runner's validation and the approval gate protect you either way, but a worse model just wastes steps.

## What this does not do

- It does not retrain anything by itself.
- Prompt changes bump `PROMPT_VERSION` in `apps/mcp-server/src/goal-runner.ts`; traces record the version so old data can be filtered.
