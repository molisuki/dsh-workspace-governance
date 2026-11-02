import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {apply} from '../lib/index.js';
import {createRegistry} from '../lib/core.js';
import {embeddedSkillLocations} from '../lib/embedded-skills.js';
import {effectiveSkillSettings,validateSkillSettings,renderSkillPrompt,skillStrategyFeedback,cancellationPrompt,DEFAULT_CUSTOM_PROMPT,DEFAULT_EMBEDDED_PROMPT,DEFAULT_CUSTOM_CANCEL_PROMPT,DEFAULT_EMBEDDED_CANCEL_PROMPT} from '../lib/skill-strategy.js';

test('editable Skill configuration safely substitutes trigger-threshold and target-usage variables',()=>{
 const defaults=effectiveSkillSettings({});
 assert.equal(defaults.mode,'embedded');
 assert.equal(defaults.customSkill.length>0,true);
 assert.equal(defaults.customPrompt.length>80,true);
 assert.equal(defaults.embeddedPrompt.length>80,true);
 const vars={file:'notes/a.md',limit:2400,count:2200,warningPercent:80,targetPercent:10,
  triggerPercent:80,targetUsagePercent:70,targetCount:1680,requiredReduction:520,trigger:'预警'};
 assert.equal(renderSkillPrompt('{{file}} {{requiredReduction}} {{trigger}}',vars),'notes/a.md 520 预警');
 assert.equal(renderSkillPrompt('{{triggerPercent}} {{targetUsagePercent}} {{targetCount}}',vars),'80 70 1680');
 assert.throws(()=>validateSkillSettings({...defaults,mode:'invalid'}),/Invalid Skill mode/);
 assert.throws(()=>validateSkillSettings({...defaults,customPrompt:'{{hijack}}'}),/Unknown prompt variable/);
 assert.throws(()=>validateSkillSettings({...defaults,customSkill:'x'.repeat(24001)}),/Invalid customSkill/);
 assert.throws(()=>validateSkillSettings({...defaults,embeddedPrompt:''}),/Empty Skill text/);
 assert.throws(()=>validateSkillSettings({...defaults,embeddedPrompt:'bad\0text'}),/Invalid embeddedPrompt/);
 assert.equal(validateSkillSettings({...defaults,customSkill:'Literal {{user_defined}} may be documentation'}).mode,'embedded');
});

test('cancellation templates use matching Skill modes while legacy settings remain valid',()=>{
 const oldSettings={mode:'custom',customSkill:'Rule',customPrompt:'Advice',embeddedPrompt:'Embedded'};
 assert.equal(validateSkillSettings(oldSettings),oldSettings);
 const migrated=effectiveSkillSettings({skillSettings:oldSettings});
 assert.equal(migrated.customPrompt,'Advice');
 assert.equal(migrated.customCancelPrompt,DEFAULT_CUSTOM_CANCEL_PROMPT);
 assert.equal(migrated.embeddedCancelPrompt,DEFAULT_EMBEDDED_CANCEL_PROMPT);
 const custom={...migrated,customCancelPrompt:'CUSTOM CANCEL {{items}}',
  embeddedCancelPrompt:'EMBEDDED CANCEL {{items}}'};
 assert.equal(cancellationPrompt({skillSettings:custom},'target.md'),'CUSTOM CANCEL target.md');
 assert.equal(cancellationPrompt({skillSettings:{...custom,mode:'embedded'}},'target.md'),'EMBEDDED CANCEL target.md');
 assert.equal(cancellationPrompt({skillSettings:{...custom,mode:'off'}},'target.md'),
  'WORKSPACE_GOVERNANCE: CANCEL\ntarget.md\n只停止上述旧任务；其他任务不变。');
 assert.throws(()=>validateSkillSettings({...custom,customCancelPrompt:'omit targets'}),/Missing cancellation items placeholder/);
 assert.throws(()=>validateSkillSettings({...custom,embeddedCancelPrompt:'{{items}} {{injected}}'}),/Unknown prompt variable/);
});

test('selected Skill mode controls non-blocking session advice, independent of any write hook',()=>{
 const base={...effectiveSkillSettings({}),customSkill:'Professional scope remains authorized',
  customPrompt:'CUSTOM {{file}} {{targetUsagePercent}}',embeddedPrompt:'EMBEDDED {{file}} {{targetUsagePercent}}'};
 const decision={limit:100,projected:92};
 const target={percent:10,triggerPercent:80,targetUsagePercent:70,targetCount:70,requiredReduction:22};
 for(const [mode,needle] of [['custom','CUSTOM notes.md 70'],['embedded','EMBEDDED notes.md 70'],['off','']]){
  const text=skillStrategyFeedback({skillSettings:{...base,mode},warningRatio:.8},'notes.md',decision,target,'warning');
  if(mode==='off')assert.equal(text,'');
  else assert.ok(text.includes(needle));
 }
});

test('three independent foldable cards, both three-mode radios and edited prompts appear without another navigation tab',async()=>{
 const code=await fs.readFile(new URL('../lib/client.js',import.meta.url),'utf8');
 assert.ok(code.includes('advisoryExpanded?c('));
 assert.ok(code.includes('skillExpanded?c('));
 assert.ok(code.includes('detectionExpanded?c('));
 assert.ok(code.includes("c('strong',null,'文件变更检测')"));
 assert.ok(code.includes("'aria-controls':'wg-detection-content'"));
 assert.ok(code.includes("c('strong',null,'Agent 容量提示')"));
 assert.ok(code.includes("c('strong',null,'Agent 精简 Skill')"));
 assert.ok(code.includes("'aria-label':'Agent 精简 Skill 模式'"));
 assert.ok(code.includes("type:'radio',name:'wg-skill-mode'"));
 for(const label of ['自定义 Skill','内置 Skill','关闭 Skill','自定义 Skill 规范','自定义 Agent 精简提示词','内置 Skill Agent 精简提示词','导入 Skill 文件'])
  assert.ok(code.includes(label),label);
 assert.ok(code.includes("request('/skill-settings','PUT'"));
 assert.ok(code.includes("maintenancePanel,\n     detectionPanel,\n     skillPanel"));
 assert.ok(code.includes("['tree','目录'],['warning','预警'],['overflow','超限'],['overrides','专项'],['logs','日志']"));
});
