// Geometry evidence for screenshot review; synthetic visual state is measured separately.
import assert from 'node:assert/strict';
export async function collectGroupLayout(page, label) {
  const metrics = await page.locator('[data-testid=group-view]:visible').evaluate((root,label) => {
    const rect=node=>{
      const r=node.getBoundingClientRect();
      return Object.fromEntries(['left','right','top','bottom','width','height'].map(key=>[key,Math.round(r[key]*100)/100]));
    };
    const timeline=root.querySelector('[data-testid=group-timeline]');
    const composer=root.querySelector('[data-testid=group-composer]');
    const items=[...timeline.querySelectorAll('[data-author],.gc-live')];
    const blocks=[...timeline.querySelectorAll(':scope > .gc-timeline-item')];
    const memberCards=[...root.querySelectorAll('.gc-member')].map(rect); const byRow={}; for(const card of memberCards){const key=card.top; (byRow[key]??=[]).push(card);} const replyCards=[...root.querySelectorAll('.gc-message.is-member')].map(card=>{const r=rect(card), actions=card.querySelector('.gc-reply-actions'), content=[...card.children].filter(node=>!node.matches('header')) .at(-1), cr=content&&rect(content); return {rect:r,actionsInHeader:actions?.closest('header')===card.querySelector(':scope > header'),paddingBottom:Math.round(parseFloat(getComputedStyle(card).paddingBottom)||0),contentGap:cr?r.bottom-cr.bottom:undefined};}); const replyHandles=[...root.querySelectorAll('.gc-message.is-member header strong')].map(node=>({text:node.textContent,scrollWidth:node.scrollWidth,clientWidth:node.clientWidth,height:rect(node).height})); const controls=[...root.querySelectorAll('button,.tt-select-trigger')].filter(node=>{
      const r=node.getBoundingClientRect();return r.width&&r.height&&getComputedStyle(node).visibility!=='hidden';
    });
    const controlRows=[];
    for(const node of controls){
      const box=rect(node),center=(box.top+box.bottom)/2;
      let row=controlRows.find(row=>row.parent===node.parentElement&&Math.abs(row.center-center)<2);
      if(!row){row={parent:node.parentElement,center,controls:[]};controlRows.push(row);}
      row.controls.push({name:node.getAttribute('aria-label')||node.textContent?.trim(),...box});
    }
    const tr=rect(timeline),cr=rect(composer),style=getComputedStyle(timeline);
    return {
      label,surfaceWidth:rect(root).width,viewportWidth:innerWidth,timeline:tr,composer:cr,scrollbarWidth:timeline.offsetWidth-timeline.clientWidth,scrollLeft:timeline.scrollLeft,
      column:{left:tr.left+parseFloat(style.paddingLeft),right:tr.right-parseFloat(style.paddingRight)},
      items:items.map(node=>({kind:node.getAttribute('data-author')||'delivery',messageId:node.getAttribute('data-message-id'),
        state:node.getAttribute('data-delivery-state'),rect:rect(node),bubble:node.querySelector('.gc-user-bubble')?rect(node.querySelector('.gc-user-bubble')):undefined})),
      gaps:blocks.slice(1).map((node,index)=>Math.round((node.getBoundingClientRect().top-blocks[index].getBoundingClientRect().bottom)*100)/100),
      memberCards,memberRows:Object.values(byRow),replyCards,replyHandles,
      controlRows:controlRows.map(({center,controls})=>({center,controls})),
    };
  },label);
  assert.ok(metrics.composer.width>0,`${label} composer is measurable`);
  assert.ok(Math.abs(metrics.composer.left-metrics.column.left)<=1,`${label} composer aligns with reading column`);
  assert.ok(Math.abs(metrics.composer.right-metrics.column.right)<=1,`${label} composer right aligns with reading column`);
  for(const item of metrics.items){
    assert.ok(Math.abs(item.rect.left-metrics.column.left)<=1,`${label} item left ${item.rect.left} aligns with ${metrics.column.left} (scrollLeft ${metrics.scrollLeft})`);
    assert.ok(Math.abs(item.rect.right-metrics.column.right)<=1,`${label} item right aligns`);
  }
  for(const handle of metrics.replyHandles)assert.ok(handle.scrollWidth<=handle.clientWidth,`${label} reply handle is not truncated: ${handle.text}`); for(const card of metrics.replyCards){assert.equal(card.actionsInHeader,true,`${label} reply actions are in the header`); assert.ok(card.paddingBottom<=16,`${label} reply padding <=16`); if(card.contentGap!==undefined)assert.ok(card.contentGap<=16,`${label} reply content gap <=16`);} for(const row of metrics.memberRows){for(const card of row)assert.equal(card.height,36,`${label} member card height`);} if(metrics.surfaceWidth<=900&&metrics.memberCards.length>=6)assert.equal(metrics.memberRows.length,3,`${label} six member cards use three rows at 900`); return metrics;
}
