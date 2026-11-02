export const SKILL_MODES=Object.freeze(['custom','embedded','off']);
export const PROMPT_VARIABLES=Object.freeze(['file','limit','count','warningPercent','targetPercent','triggerPercent','targetUsagePercent','targetCount','requiredReduction','trigger']);
export const DEFAULT_CUSTOM_SKILL=[
  '适用范围：当前任务涉及的容量触发 Markdown 文档。',
  '转换：识别真实冗余并执行最小化结构与表述收敛。',
  '验收：保全事实、关系、数值、链接、权限及有效约束。'
].join('\n');
export const DEFAULT_EMBEDDED_PROMPT=[
  '依内置两项 Skill 的职责与准入契约识别真实冗余、失效描述与无效结构。',
  '先完成依赖与语义等价验证，再按任务主体给定的容量目标实施局部收敛；任何不确定项保留并记录证据缺口。'
].join('\n');
export const DEFAULT_CUSTOM_PROMPT=[
  '依自定义 Skill 的准入与验收规程处理当前目标文档，优先消除重复、过时与失效内容。',
  '采用任务主体中的容量目标；变更后验证结构、事实、关系与接口契约的一致性，并报告无法收敛的缺陷。'
].join('\n');
export const DEFAULT_EMBEDDED_CANCEL_PROMPT='WORKSPACE_GOVERNANCE: CANCEL\n{{items}}\n只停止上述旧任务；其他任务不变。';
export const DEFAULT_CUSTOM_CANCEL_PROMPT=DEFAULT_EMBEDDED_CANCEL_PROMPT;
const defaults=Object.freeze({mode:'embedded',customSkill:DEFAULT_CUSTOM_SKILL,customPrompt:DEFAULT_CUSTOM_PROMPT,embeddedPrompt:DEFAULT_EMBEDDED_PROMPT,
  customCancelPrompt:DEFAULT_CUSTOM_CANCEL_PROMPT,embeddedCancelPrompt:DEFAULT_EMBEDDED_CANCEL_PROMPT});
const sizes=Object.freeze({customSkill:24000,customPrompt:12000,embeddedPrompt:12000,
  customCancelPrompt:12000,embeddedCancelPrompt:12000});

export function effectiveSkillSettings(policy){
  const saved=policy.skillSettings??{};
  return {...defaults,...saved,customCancelPrompt:saved.customCancelPrompt??DEFAULT_CUSTOM_CANCEL_PROMPT,
    embeddedCancelPrompt:saved.embeddedCancelPrompt??DEFAULT_EMBEDDED_CANCEL_PROMPT};
}
export function validateSkillSettings(settings){
  if(!settings||typeof settings!=='object'||Array.isArray(settings))throw Error('Invalid Skill settings');
  if(Object.keys(settings).some(k=>k!=='mode'&&!Object.hasOwn(sizes,k)))
    throw Error('Invalid Skill setting key');
  if(!SKILL_MODES.includes(settings.mode))throw Error('Invalid Skill mode');
  for(const [key,max] of Object.entries(sizes)){
    const value=settings[key];
    if((key==='customCancelPrompt'||key==='embeddedCancelPrompt')&&value===undefined)continue;
    if(typeof value!=='string'||value.length>max||value.includes('\0'))throw Error('Invalid '+key);
    if(key.endsWith('CancelPrompt')&&!value.includes('{{items}}'))throw Error('Missing cancellation items placeholder');
    if(!value.trim())throw Error('Empty Skill text or prompt: '+key);
    if(key!=='customSkill')for(const match of value.matchAll(/\{\{([^{}]+)\}\}/g)){
      if(key.endsWith('CancelPrompt')?match[1]!=='items':!PROMPT_VARIABLES.includes(match[1]))
        throw Error('Unknown prompt variable: '+match[1]);
    }
  }
  return settings;
}
export function renderSkillPrompt(template,values){
  return template.replace(/\{\{([A-Za-z]+)\}\}/g,(_all,name)=>String(values[name]??''));
}
export function cancellationPrompt(policy,items){
  const settings=effectiveSkillSettings(policy);
  const template=settings.mode==='custom'?settings.customCancelPrompt:
    settings.mode==='embedded'?settings.embeddedCancelPrompt:DEFAULT_EMBEDDED_CANCEL_PROMPT;
  return renderSkillPrompt(template,{items});
}
const safetyBoundary=[
  '复用已加载 Skill；运行时补齐缺失的 Skill。精简须符合任务权限与语义等价要求。'
].join('\n');
export function skillStrategyFeedback(policy,relative,decision,target,trigger){
  const settings=effectiveSkillSettings(policy);
  if(settings.mode==='off')return '';
  const variables={
    file:relative,limit:decision.limit,count:decision.projected,
    warningPercent:Math.round(policy.warningRatio*100),targetPercent:target.percent,
    triggerPercent:target.triggerPercent,targetUsagePercent:target.targetUsagePercent,targetCount:target.targetCount,
    requiredReduction:target.requiredReduction,trigger:trigger==='warning'?'预警':'超限'
  };
  const chosen=settings.mode==='custom'?
    ['SKILL: workspace-governance-custom',renderSkillPrompt(settings.customPrompt,variables)]:
    ['SKILLS: semantic-refactor-forge, forensic-prune',renderSkillPrompt(settings.embeddedPrompt,variables)];
  return [...chosen,safetyBoundary].join('\n\n');
}
