<template>
  <!-- index.html's bizStepChips: one column of one step, telling apart what the step says itself,
       what its chart row supplies, what it overrides, and the owner it inherits. -->
  <div v-if="!chips.length" class="cell-chips empty">·</div>
  <div v-else class="cell-chips"><span v-for="(c, i) in chips" :key="i" class="raci-chip" :class="c.cls" :title="c.title">{{ c.text }}</span></div>
</template>

<script setup lang="ts">
/**
 * The chips in one RACI cell of a flow step — index.html's bizStepChips, for the table pane.
 *
 *   plain       authored on the step (Free-Form, or a step with no chart row behind it);
 *   from-chart  supplied by the linked row, and not the step's to edit until it takes the column back;
 *   override    authored on the step although a row supplies that column — the tooltip says what the
 *               row says, and ⊘ says "deliberately nothing here";
 * plus the dashed owner an ANCHORED flow inherits from the chart cascade, on a step naming none.
 */
import { COLS, framework, translateLetters, type ColKey, type Flow, type FlowStep, type StepRaci } from '@raci/core';

const props = defineProps<{ flow: Flow; step: FlowStep; col: ColKey; eff: StepRaci }>();
const chrome = useFlowChrome();

const chips = computed(() => {
  const b = props.flow, t = props.step, col = props.col, eff = props.eff;
  const F = framework(b.framework);
  const label = (l: string) => F.meta[l]?.label ?? l;
  const cell = eff[col];
  const bind = chrome.isLinked(b) ? chrome.bindInfo(t) : null;
  const ownerCol = chrome.anchorInfo(b)?.ownerColumn ?? null;
  const out: Array<{ text: string; cls: string[]; title?: string }> = [];
  if (cell.from === 'chart') {
    for (const l of cell.letters.split('').filter(Boolean)) {
      out.push({ text: l, cls: [l, 'from-chart'],
        title: `${label(l)} — from the linked ${bind!.tierLabel.toLowerCase()} row “${bind!.node.name || 'untitled'}” (${chrome.colLabel(col)})` });
    }
  } else {
    const overridden = !!bind && t.bindOverrides.includes(col);
    const chartSays = overridden ? translateLetters(bind!.ctx.raci[col], bind!.ctx.framework, F) : '';
    const says = chartSays ? `the row says ${chartSays}` : 'the row assigns nothing here';
    for (const l of cell.letters.split('').filter(Boolean)) {
      const cascadeOver = !overridden && !!ownerCol && l === F.owner && col !== ownerCol;
      const title = overridden
        ? `${label(l)} — set on this step, overriding the linked chart row (${says})`
        : cascadeOver
          ? `${label(F.owner)} set here, but the chart cascade puts ownership on ${chrome.colLabel(ownerCol!)} — branch override`
          : undefined;
      out.push({ text: l, cls: overridden || cascadeOver ? [l, 'override'] : [l], title });
    }
    // A column deliberately overridden to nothing still has to SAY so.
    if (overridden && !cell.letters && chartSays) {
      out.push({ text: '⊘', cls: ['none', 'override'], title: `No role here on this step — overriding the linked chart row, where ${says}` });
    }
  }
  if (ownerCol === col && !COLS.some((k) => eff[k].letters.includes(F.owner))) {
    out.push({ text: F.owner, cls: [F.owner, 'inherited'], title: `${label(F.owner)} — inherited from the chart cascade (${chrome.colLabel(col)})` });
  }
  return out;
});
</script>
