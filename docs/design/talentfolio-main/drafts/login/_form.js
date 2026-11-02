// 정적 시안 — 실제 인증 연결 없음. 검증·역할 전환 데모만.
(function(){
  const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
  // role segmented control (radiogroup, 화살표 키 지원)
  $$('.seg').forEach(seg=>{
    const btns=$$('button',seg);
    const set=(b,focus)=>{btns.forEach(x=>{x.setAttribute('aria-checked',x===b);x.tabIndex=x===b?0:-1});seg.dataset.role=b.dataset.role;if(focus)b.focus();
      document.documentElement.dataset.role=b.dataset.role;document.dispatchEvent(new CustomEvent('rolechange',{detail:b.dataset.role}));};
    btns.forEach((b,i)=>{b.addEventListener('click',()=>set(b));b.addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();set(btns[(i+(e.key==='ArrowRight'?1:btns.length-1))%btns.length],true)}})});
  });
  $$('.pw button').forEach(b=>b.addEventListener('click',()=>{const i=b.previousElementSibling;const show=i.type==='password';i.type=show?'text':'password';b.textContent=show?'숨기기':'보기';b.setAttribute('aria-pressed',show)}));
  window.tfValidate=function(form){
    let first=null;
    $$('[data-v]',form).forEach(inp=>{
      if(inp.offsetParent===null)return;
      const e=$('#'+inp.getAttribute('aria-describedby').split(' ')[0]);let msg='';
      const v=inp.value.trim();
      if(!v)msg=inp.dataset.v==='email'?'이메일을 입력해 주세요.':'비밀번호를 입력해 주세요.';
      else if(inp.dataset.v==='email'&&!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v))msg='이메일 형식이 올바르지 않습니다. 예: name@company.com';
      else if(inp.dataset.v==='pw'&&v.length<6)msg='비밀번호는 6자 이상이어야 합니다.';
      e.textContent=msg;inp.setAttribute('aria-invalid',!!msg);if(msg&&!first)first=inp;
    });
    if(first)first.focus();return !first;
  };
  $$('form[data-demo]').forEach(f=>f.addEventListener('submit',ev=>{ev.preventDefault();
    if(!tfValidate(f))return;
    const a=$('.alert',f);if(a){a.classList.add('on');a.focus()}
  }));
})();
