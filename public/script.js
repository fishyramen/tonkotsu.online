<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>tonkotsu.online</title>

  <style>
    :root{
      --bg:#07080a;
      --bg2:#0a0c0f;
      --panel:rgba(255,255,255,.035);
      --panel2:rgba(255,255,255,.02);
      --stroke:rgba(255,255,255,.08);
      --stroke2:rgba(255,255,255,.11);
      --text:#e9eff6;
      --muted:#98a6b6;

      --danger:#ff4b4b;

      --online:#43d18b;
      --idle:#ffd166;
      --dnd:#ff5252;
      --offline:#6b7a90;

      --radius:14px;
      --shadow: 0 18px 60px rgba(0,0,0,.55);
      --shadow2: 0 12px 40px rgba(0,0,0,.45);

      --ease: cubic-bezier(.2,.8,.2,1);
      --fast: 140ms var(--ease);
      --med: 220ms var(--ease);
      --slow: 420ms var(--ease);

      --h: 36px; /* control height */
      --gap: 10px;
    }

    *{ box-sizing:border-box; }
    html,body{ height:100%; }
    body{
      margin:0;
      background: radial-gradient(900px 900px at 20% 10%, rgba(255,255,255,.06), transparent 60%),
                  radial-gradient(1000px 900px at 88% 70%, rgba(255,255,255,.05), transparent 60%),
                  linear-gradient(180deg, var(--bg), var(--bg2));
      color:var(--text);
      font: 520 12.5px/1.35 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
      overflow:hidden;
    }

    /* ===== DOTTED STAR BACKGROUND (with motion) ===== */
    .bg{
      position:fixed; inset:0;
      pointer-events:none;
      overflow:hidden;
      filter: contrast(1.05) saturate(1.05);
    }
    .starLayer{
      position:absolute; inset:-240px;
      background-repeat:repeat;
      opacity:.7;
      animation: driftA 110s linear infinite;
      transform: translate3d(0,0,0);
      will-change: transform;
    }
    .starLayer.l1{
      background-size: 280px 280px;
      opacity:.70;
      background-image:
        radial-gradient(1px 1px at 12px 18px, rgba(255,255,255,.60), transparent 45%),
        radial-gradient(1px 1px at 54px 120px, rgba(255,255,255,.70), transparent 45%),
        radial-gradient(1px 1px at 98px 52px, rgba(255,255,255,.55), transparent 45%),
        radial-gradient(1px 1px at 160px 210px, rgba(255,255,255,.62), transparent 45%),
        radial-gradient(1px 1px at 220px 160px, rgba(255,255,255,.58), transparent 45%),
        radial-gradient(1px 1px at 250px 30px, rgba(255,255,255,.68), transparent 45%);
    }
    .starLayer.l2{
      background-size: 380px 380px;
      opacity:.45;
      animation: driftB 165s linear infinite;
      background-image:
        radial-gradient(1px 1px at 26px 40px, rgba(255,255,255,.62), transparent 45%),
        radial-gradient(1px 1px at 120px 210px, rgba(255,255,255,.55), transparent 45%),
        radial-gradient(1px 1px at 240px 90px, rgba(255,255,255,.70), transparent 45%),
        radial-gradient(1px 1px at 320px 310px, rgba(255,255,255,.58), transparent 45%);
    }
    .starLayer.l3{
      background-size: 560px 560px;
      opacity:.25;
      animation: driftC 220s linear infinite;
      background-image:
        radial-gradient(1px 1px at 180px 150px, rgba(255,255,255,.62), transparent 45%),
        radial-gradient(1px 1px at 360px 260px, rgba(255,255,255,.56), transparent 45%),
        radial-gradient(1px 1px at 420px 80px, rgba(255,255,255,.70), transparent 45%);
    }
    @keyframes driftA { from{ transform:translate3d(0,0,0);} to{ transform:translate3d(-280px,-280px,0);} }
    @keyframes driftB { from{ transform:translate3d(0,0,0);} to{ transform:translate3d(-380px,-380px,0);} }
    @keyframes driftC { from{ transform:translate3d(0,0,0);} to{ transform:translate3d(-560px,-560px,0);} }

    /* subtle twinkle overlay */
    .twinkle{
      position:absolute; inset:0;
      background: radial-gradient(700px 700px at 65% 35%, rgba(255,255,255,.06), transparent 55%),
                  radial-gradient(800px 800px at 35% 75%, rgba(255,255,255,.05), transparent 60%);
      opacity:.55;
      animation: twinkle 8s ease-in-out infinite;
      mix-blend-mode: screen;
    }
    @keyframes twinkle{
      0%,100%{ opacity:.42; filter: blur(0px); }
      50%{ opacity:.60; filter: blur(.3px); }
    }

    /* ===== SHELL / APP CARD ===== */
    .shell{
      position:fixed; inset:0;
      display:flex;
      align-items:center;
      justify-content:center;
      padding: 22px;
    }
    .card{
      width:min(980px, 100%);
      height:min(720px, 100%);
      border:1px solid var(--stroke);
      border-radius: 18px;
      background: rgba(8,10,13,.78);
      backdrop-filter: blur(12px);
      box-shadow: var(--shadow);
      display:flex;
      overflow:hidden;
      position:relative;
      transform: translateZ(0);
      will-change: transform, filter;
      animation: cardIn 520ms var(--ease) both;
    }
    @keyframes cardIn{
      from{ opacity:0; transform: translateY(10px) scale(.985); filter: blur(2px); }
      to{ opacity:1; transform: translateY(0) scale(1); filter: blur(0); }
    }

    /* ===== UNIVERSAL CONTROLS ===== */
    .btn{
      height: var(--h);
      padding: 0 12px;
      border-radius: 12px;
      border:1px solid var(--stroke2);
      background: rgba(255,255,255,.04);
      color:var(--text);
      cursor:pointer;
      user-select:none;
      display:inline-flex;
      align-items:center;
      justify-content:center;
      gap:10px;
      font-weight: 900;
      letter-spacing:.2px;
      transition: transform var(--fast), background var(--fast), border-color var(--fast), box-shadow var(--fast), filter var(--fast);
      position:relative;
      overflow:hidden;
      -webkit-tap-highlight-color: transparent;
    }
    .btn:hover{
      background: rgba(255,255,255,.06);
      transform: translateY(-1px);
      box-shadow: 0 10px 30px rgba(0,0,0,.35);
    }
    .btn:active{
      transform: translateY(0) scale(.985);
      filter: brightness(1.04);
    }
    .btn.primary{
      background: rgba(255,255,255,.10);
      border-color: rgba(255,255,255,.16);
    }
    .btn.ghost{
      background: transparent;
      border-color: rgba(255,255,255,.10);
    }
    .btn.small{
      height: 30px;
      padding: 0 10px;
      border-radius: 11px;
      font-size: 12px;
      font-weight: 900;
    }
    .btn:disabled{
      opacity:.55;
      cursor:not-allowed;
      transform:none !important;
      box-shadow:none !important;
    }
    .btn .ripple{
      position:absolute;
      width: 10px; height: 10px;
      border-radius: 999px;
      background: rgba(255,255,255,.22);
      transform: translate(-50%,-50%);
      pointer-events:none;
      animation: ripple 520ms var(--ease) both;
    }
    @keyframes ripple{
      from{ opacity:.65; transform: translate(-50%,-50%) scale(1); }
      to{ opacity:0; transform: translate(-50%,-50%) scale(22); }
    }

    .field{
      height: var(--h);
      width:100%;
      padding: 0 12px;
      border-radius: 12px;
      border:1px solid rgba(255,255,255,.10);
      background: rgba(255,255,255,.03);
      color:var(--text);
      outline:none;
      transition: border-color var(--fast), background var(--fast), transform var(--fast);
    }
    .field:focus{
      border-color: rgba(255,255,255,.22);
      background: rgba(255,255,255,.04);
      transform: translateY(-1px);
    }
    .muted{ color:var(--muted); font-size:12px; }
    .muted.tiny{ font-size:11px; }

    /* ===== ICONS (NO LETTERS) ===== */
    .ico{
      width: 18px;
      height: 18px;
      display:inline-flex;
      align-items:center;
      justify-content:center;
      opacity:.95;
      flex: 0 0 auto;
    }
    .ico svg{ width:18px; height:18px; stroke: rgba(255,255,255,.88); fill:none; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }

    /* ===== BADGES ===== */
    .badge{
      min-width: 18px;
      height: 18px;
      padding: 0 6px;
      border-radius: 8px;
      background: var(--danger);
      color:#0b0d10;
      font-weight: 950;
      font-size: 11px;
      display:none;
      align-items:center;
      justify-content:center;
      line-height:18px;
      box-shadow: 0 10px 28px rgba(0,0,0,.30);
      transform: translateZ(0);
      animation: pop 240ms var(--ease) both;
    }
    .badge.show{ display:flex; }
    @keyframes pop{
      from{ transform: scale(.8); opacity:0; }
      to{ transform: scale(1); opacity:1; }
    }

    /* ===== LOGIN OVERLAY ===== */
    .overlay{
      position:absolute; inset:0;
      display:flex;
      align-items:center;
      justify-content:center;
      background: rgba(0,0,0,.58);
      backdrop-filter: blur(10px);
      z-index: 50;
      opacity: 1;
      transition: opacity var(--med), transform var(--med), filter var(--med);
    }
    .overlay.hidden{ opacity:0; pointer-events:none; }

    .loginCard{
      width:min(420px, 94vw);
      border:1px solid var(--stroke);
      border-radius: 18px;
      background: rgba(10,12,15,.92);
      box-shadow: var(--shadow2);
      padding: 16px;
      display:flex;
      flex-direction:column;
      gap: 12px;
      transform: translateY(0);
      animation: loginIn 520ms var(--ease) both;
    }
    @keyframes loginIn{
      from{ opacity:0; transform: translateY(10px) scale(.985); filter: blur(2px); }
      to{ opacity:1; transform: translateY(0) scale(1); filter: blur(0); }
    }

    .brandRow{
      display:flex; align-items:center; justify-content:space-between; gap:10px;
    }
    .brand{
      font-weight: 950;
      letter-spacing: .2px;
      font-size: 15px;
    }

    .passRow{ position:relative; }
    .eye{
      position:absolute;
      right: 8px;
      top: 50%;
      transform: translateY(-50%);
      height: 30px;
      width: 38px;
      border-radius: 12px;
      border:1px solid rgba(255,255,255,.10);
      background: rgba(255,255,255,.03);
      display:flex;
      align-items:center;
      justify-content:center;
      cursor:pointer;
      transition: background var(--fast), transform var(--fast), border-color var(--fast);
      user-select:none;
    }
    .eye:hover{ background: rgba(255,255,255,.05); transform: translateY(-50%) translateY(-1px); }

    .btnRow{
      display:flex;
      gap:10px;
      align-items:center;
    }
    .btnRow .btn{ flex:1; }

    /* ===== MAIN LAYOUT ===== */
    .layout{ flex:1; display:flex; min-width:0; min-height:0; }
    .sidebar{
      width: 290px;
      border-right: 1px solid var(--stroke);
      padding: 10px;
      display:flex;
      flex-direction:column;
      gap: 10px;
      min-width: 260px;
      max-width: 320px;
      min-height:0;
      background: rgba(0,0,0,.18);
    }
    .main{
      flex:1;
      display:flex;
      flex-direction:column;
      min-width:0;
      min-height:0;
    }

    /* ===== ROWS / LIST ITEMS ===== */
    .row{
      height: 42px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap: 12px;
      padding: 0 10px;
      border-radius: 14px;
      border:1px solid rgba(255,255,255,.07);
      background: rgba(255,255,255,.02);
      cursor:pointer;
      user-select:none;
      transition: transform var(--fast), background var(--fast), border-color var(--fast), box-shadow var(--fast);
      position:relative;
      overflow:hidden;
    }
    .row:hover{
      background: rgba(255,255,255,.03);
      border-color: rgba(255,255,255,.10);
      transform: translateY(-1px);
      box-shadow: 0 12px 32px rgba(0,0,0,.35);
    }
    .row:active{
      transform: translateY(0) scale(.99);
    }
    .row::after{
      content:"";
      position:absolute; inset:0;
      background: radial-gradient(400px 140px at 20% 0%, rgba(255,255,255,.08), transparent 55%);
      opacity:0;
      transition: opacity var(--fast);
      pointer-events:none;
    }
    .row:hover::after{ opacity:1; }

    .rowLeft{ display:flex; align-items:center; gap:10px; min-width:0; }
    .nameCol{ min-width:0; display:flex; flex-direction:column; gap:2px; }
    .rowName{ font-weight: 950; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .rowSub{ font-size:11px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

    .chip{
      height: 24px;
      padding: 0 10px;
      border-radius: 999px;
      border:1px solid rgba(255,255,255,.10);
      background: rgba(255,255,255,.03);
      display:inline-flex;
      align-items:center;
      gap:8px;
      font-size:11px;
      color: rgba(255,255,255,.88);
      user-select:none;
    }

    /* ===== STATUS DOTS ===== */
    .statusDot{
      width:10px; height:10px;
      border-radius: 99px;
      border:1px solid rgba(255,255,255,.14);
      background: rgba(255,255,255,.18);
      flex: 0 0 auto;
      position:relative;
      animation: dotIn 260ms var(--ease) both;
    }
    @keyframes dotIn{ from{ transform:scale(.7); opacity:0; } to{ transform:scale(1); opacity:1; } }
    .statusDot.online{ background: var(--online); box-shadow: 0 0 0 3px rgba(67,209,139,.12); }
    .statusDot.idle{ background: var(--idle); box-shadow: 0 0 0 3px rgba(255,209,102,.12); }
    .statusDot.dnd{ background: var(--dnd); box-shadow: 0 0 0 3px rgba(255,82,82,.12); }
    .statusDot.offline{ background: var(--offline); box-shadow: 0 0 0 3px rgba(107,122,144,.12); }

    /* ===== TOPBAR ===== */
    .topbar{
      height: 56px;
      padding: 10px 12px;
      border-bottom:1px solid var(--stroke);
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap: 12px;
      min-width:0;
      background: rgba(0,0,0,.12);
    }
    .titleBlock{ min-width:0; display:flex; flex-direction:column; gap:2px; }
    .chatTitle{
      font-weight: 950;
      font-size: 12.5px;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
      letter-spacing:.2px;
      transition: transform var(--fast), opacity var(--fast);
    }
    .chatTitle.clickable{ cursor:pointer; }
    .chatTitle.clickable:hover{ transform: translateY(-1px); }
    .chatHint{ font-size:11px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

    .mePill{
      height: 38px;
      padding: 0 10px;
      border-radius: 999px;
      border:1px solid rgba(255,255,255,.10);
      background: rgba(255,255,255,.03);
      display:none;
      align-items:center;
      gap:10px;
      cursor:pointer;
      user-select:none;
      min-width: 0;
      transition: transform var(--fast), background var(--fast), border-color var(--fast), box-shadow var(--fast);
    }
    .mePill:hover{
      transform: translateY(-1px);
      background: rgba(255,255,255,.05);
      box-shadow: 0 12px 34px rgba(0,0,0,.35);
    }
    .meName{ font-weight: 950; font-size: 12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width: 180px; }
    .meSub{ font-size:11px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width: 180px; }

    /* ===== SCROLL ===== */
    .scroll{ overflow:auto; min-height:0; padding-right: 2px; }
    .scroll::-webkit-scrollbar{ width: 10px; }
    .scroll::-webkit-scrollbar-thumb{
      background: rgba(255,255,255,.08);
      border-radius: 99px;
      border: 3px solid transparent;
      background-clip: content-box;
    }

    /* ===== ONLINE PANEL (compact, collapsible) ===== */
    .panel{
      border:1px solid rgba(255,255,255,.07);
      border-radius: 16px;
      background: rgba(255,255,255,.02);
      overflow:hidden;
    }
    .panelHeader{
      height: 40px;
      padding: 0 10px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap: 10px;
      border-bottom: 1px solid rgba(255,255,255,.06);
      background: rgba(0,0,0,.10);
    }
    .panelTitle{
      display:flex;
      align-items:center;
      gap:10px;
      min-width:0;
      font-weight: 950;
      font-size: 12px;
      letter-spacing:.2px;
    }
    .panelRight{ display:flex; align-items:center; gap:10px; }
    .panelBody{
      max-height: 140px;
      transition: max-height var(--slow), opacity var(--med);
      opacity:1;
    }
    .panelBody.collapsed{
      max-height: 0px;
      opacity:0;
      overflow:hidden;
    }

    /* ===== MESSAGES PANEL ===== */
    .sectionTitle{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap: 10px;
      font-weight: 950;
      font-size: 12px;
      padding: 2px 2px 0 2px;
      letter-spacing:.2px;
    }
    .messagesPanel{
      display:flex;
      flex-direction:column;
      gap: 10px;
      flex:1;
      min-height:0;
    }

    /* ===== CHAT ===== */
    .chatBox{
      flex:1;
      padding: 12px;
      overflow:auto;
      min-height:0;
      transition: opacity var(--med), transform var(--med), filter var(--med);
    }
    .chatBox.fading{
      opacity:0;
      transform: translateY(6px);
      filter: blur(1px);
    }

    .msg{
      display:flex;
      margin-bottom: 10px;
    }
    .bubble{
      max-width: 70%;
      border:1px solid rgba(255,255,255,.07);
      background: rgba(255,255,255,.02);
      border-radius: 16px;
      padding: 10px 10px;
      transform: translateY(0);
      transition: transform var(--fast), background var(--fast), border-color var(--fast), box-shadow var(--fast);
      animation: msgIn 320ms var(--ease) both;
      box-shadow: 0 10px 28px rgba(0,0,0,.25);
    }
    @keyframes msgIn{
      from{ opacity:0; transform: translateY(6px); filter: blur(1px); }
      to{ opacity:1; transform: translateY(0); filter: blur(0); }
    }
    .bubble:hover{
      background: rgba(255,255,255,.03);
      transform: translateY(-1px);
      border-color: rgba(255,255,255,.10);
      box-shadow: 0 16px 42px rgba(0,0,0,.35);
    }
    .meta{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap: 10px;
      margin-bottom: 6px;
    }
    .u{
      font-weight: 950;
      font-size: 12px;
      cursor:pointer;
      user-select:none;
      transition: transform var(--fast), opacity var(--fast);
    }
    .u:hover{ transform: translateY(-1px); }
    .t{ font-size:11px; color:var(--muted); flex: 0 0 auto; }
    .body{
      font-size:12px;
      color: var(--text);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .mention{
      color: var(--danger);
      font-weight: 950;
    }

    /* ===== COMPOSER ===== */
    .composer{
      padding: 10px 12px 12px 12px;
      border-top:1px solid var(--stroke);
      display:flex;
      flex-direction:column;
      gap: 10px;
      background: rgba(0,0,0,.12);
    }
    .composerRow{
      display:flex;
      gap: 10px;
      align-items:stretch;
    }
    .composerRow .field{ flex:1; }
    .composerRow .btn{ width: 108px; }

    .cooldown{
      display:none;
      align-items:center;
      gap:10px;
      color: var(--muted);
      font-size:11px;
      user-select:none;
      transition: transform var(--fast), opacity var(--fast);
    }
    .cooldown.warn{ color: var(--danger); }
    .bar{
      flex:1;
      height: 10px;
      border-radius: 999px;
      border:1px solid rgba(255,255,255,.10);
      background: rgba(255,255,255,.05);
      overflow:hidden;
      position:relative;
    }
    .barFill{
      width:0%;
      height:100%;
      background: rgba(255,255,255,.18);
      transition: width 70ms linear;
    }
    .shake{ animation: shake 320ms ease; }
    @keyframes shake{
      0%,100%{ transform: translateX(0); }
      20%{ transform: translateX(-4px); }
      40%{ transform: translateX(4px); }
      60%{ transform: translateX(-3px); }
      80%{ transform: translateX(3px); }
    }

    /* ===== LOADING OVERLAY ===== */
    .loading{
      position:absolute; inset:0;
      display:none;
      align-items:center;
      justify-content:center;
      background: rgba(0,0,0,.58);
      backdrop-filter: blur(10px);
      z-index: 55;
      opacity:0;
      transition: opacity var(--med);
    }
    .loading.show{
      display:flex;
      opacity:1;
    }
    .loader{
      width:min(360px, 92vw);
      border:1px solid rgba(255,255,255,.10);
      border-radius: 18px;
      background: rgba(10,12,15,.92);
      box-shadow: var(--shadow2);
      padding: 16px;
      display:flex;
      flex-direction:column;
      gap: 10px;
      transform: translateY(6px);
      animation: loaderIn 320ms var(--ease) both;
    }
    @keyframes loaderIn{
      from{ opacity:0; transform: translateY(10px) scale(.99); }
      to{ opacity:1; transform: translateY(0) scale(1); }
    }
    .loadRow{ display:flex; align-items:center; gap:10px; }
    .spinner{
      width: 18px; height: 18px;
      border-radius: 999px;
      border:2px solid rgba(255,255,255,.14);
      border-top-color: rgba(255,255,255,.70);
      animation: spin 650ms linear infinite;
    }
    @keyframes spin{ to{ transform: rotate(360deg);} }
    .dots{
      display:inline-flex;
      gap:5px;
      margin-left: 2px;
    }
    .dot{
      width:6px; height:6px;
      border-radius: 99px;
      background: rgba(255,255,255,.55);
      animation: dot 900ms var(--ease) infinite;
      opacity:.5;
    }
    .dot:nth-child(2){ animation-delay: 120ms; }
    .dot:nth-child(3){ animation-delay: 240ms; }
    @keyframes dot{
      0%,100%{ transform: translateY(0); opacity:.45; }
      50%{ transform: translateY(-4px); opacity:.9; }
    }

    /* ===== MODAL ===== */
    .modalBack{
      position:fixed; inset:0;
      background: rgba(0,0,0,.58);
      backdrop-filter: blur(10px);
      display:none;
      align-items:center;
      justify-content:center;
      z-index: 60;
      padding: 18px;
      opacity: 0;
      transition: opacity var(--med);
    }
    .modalBack.show{
      display:flex;
      opacity:1;
    }
    .modal{
      width:min(560px, 96vw);
      border:1px solid rgba(255,255,255,.10);
      border-radius: 18px;
      background: rgba(10,12,15,.92);
      box-shadow: var(--shadow2);
      padding: 12px;
      display:flex;
      flex-direction:column;
      gap: 10px;
      max-height: min(72vh, 600px);
      overflow:auto;
      transform: translateY(8px);
      animation: modalIn 280ms var(--ease) both;
    }
    @keyframes modalIn{
      from{ opacity:0; transform: translateY(14px) scale(.99); filter: blur(1px); }
      to{ opacity:1; transform: translateY(0) scale(1); filter: blur(0); }
    }
    .modalTop{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap: 10px;
      position:sticky;
      top:0;
      background: rgba(10,12,15,.92);
      padding-bottom: 8px;
      z-index: 2;
    }
    .modalTitle{
      font-weight: 950;
      font-size: 13px;
      letter-spacing:.2px;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }

    /* ===== TOASTS ===== */
    .toasts{
      position:fixed;
      right: 16px;
      bottom: 16px;
      display:flex;
      flex-direction:column;
      gap:10px;
      z-index: 80;
      pointer-events:none;
    }
    .toast{
      width: min(340px, 92vw);
      border:1px solid rgba(255,255,255,.10);
      border-radius: 16px;
      background: rgba(10,12,15,.92);
      box-shadow: var(--shadow2);
      padding: 10px 12px;
      display:flex;
      gap:10px;
      transform: translateY(0);
      opacity:1;
      transition: opacity var(--med), transform var(--med), filter var(--med);
      animation: toastIn 220ms var(--ease) both;
    }
    @keyframes toastIn{
      from{ opacity:0; transform: translateY(10px); filter: blur(1px); }
      to{ opacity:1; transform: translateY(0); filter: blur(0); }
    }
    .toastDot{
      width:10px; height:10px;
      border-radius:99px;
      background: var(--online);
      box-shadow: 0 0 0 3px rgba(67,209,139,.12);
      margin-top: 3px;
      flex:0 0 auto;
    }
    .toastTitle{ font-weight: 950; font-size:12px; }
    .toastMsg{ color:var(--muted); font-size:12px; }

    /* ===== FOOTER ===== */
    .footer{
      position:fixed;
      left: 50%;
      transform: translateX(-50%);
      bottom: 10px;
      display:flex;
      align-items:center;
      gap:12px;
      color: rgba(255,255,255,.55);
      font-size: 11px;
      z-index: 10;
      user-select:none;
      opacity:.85;
      transition: opacity var(--fast), transform var(--fast);
    }
    .footer:hover{ opacity:1; transform: translateX(-50%) translateY(-1px); }
    .footer a{ color: rgba(255,255,255,.70); text-decoration:none; }
    .footer a:hover{ text-decoration:underline; }

    /* small flourish for “dynamic” feel on focus */
    .focusGlow{
      position:absolute; inset:-2px;
      border-radius: 18px;
      pointer-events:none;
      opacity:0;
      background: radial-gradient(900px 240px at 50% 0%, rgba(255,255,255,.08), transparent 60%);
      transition: opacity var(--med);
    }
    .card:focus-within .focusGlow{ opacity:1; }

    /* layout helpers */
    .grow{ flex:1; min-width:0; }
    .tight{ display:flex; align-items:center; gap:10px; }
  </style>
</head>

<body>
  <!-- Dotted star background -->
  <div class="bg" aria-hidden="true">
    <div class="starLayer l1"></div>
    <div class="starLayer l2"></div>
    <div class="starLayer l3"></div>
    <div class="twinkle"></div>
  </div>

  <div class="shell">
    <div class="card" id="card">
      <div class="focusGlow"></div>

      <!-- Loading -->
      <div class="loading" id="loading">
        <div class="loader">
          <div class="loadRow">
            <div class="spinner"></div>
            <div style="font-weight:950;letter-spacing:.2px">Loading</div>
            <div class="dots" aria-hidden="true">
              <div class="dot"></div><div class="dot"></div><div class="dot"></div>
            </div>
          </div>
          <div class="muted" id="loaderSub">syncing…</div>
        </div>
      </div>

      <!-- Login overlay -->
      <div class="overlay" id="loginOverlay">
        <div class="loginCard" id="loginCard">
          <div class="brandRow">
            <div class="brand">tonkotsu.online</div>
            <div class="muted tiny">compact chat</div>
          </div>

          <div>
            <div class="muted" style="margin-bottom:6px">Username (letters/numbers only, min 4)</div>
            <input class="field" id="username" placeholder="yourname" autocomplete="username" />
          </div>

          <div class="passRow">
            <div class="muted" style="margin-bottom:6px">Password (letters/numbers only, min 4)</div>
            <input class="field" id="password" type="password" placeholder="••••" autocomplete="current-password" />
            <div class="eye" id="togglePass" title="Show/Hide password">
              <span class="ico" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/></svg>
              </span>
            </div>
          </div>

          <div class="btnRow">
            <button class="btn primary" id="joinBtn">Log in / Create</button>
            <button class="btn" id="guestBtn">Guest</button>
          </div>

          <div class="muted tiny" style="line-height:1.45">
            Guests can only chat in Global and have slower cooldown.
          </div>
        </div>
      </div>

      <!-- App -->
      <div class="layout" id="app">
        <div class="sidebar">
          <!-- Inbox -->
          <div class="row" id="inboxBtn" title="Inbox (mentions, invites, friend requests)">
            <div class="rowLeft">
              <span class="ico" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M4 4h16v12H4z"/><path d="M4 13h4l2 3h4l2-3h4"/></svg>
              </span>
              <div class="nameCol">
                <div class="rowName">Inbox</div>
                <div class="rowSub">mentions • invites • requests</div>
              </div>
            </div>
            <div class="badge" id="inboxPing">0</div>
          </div>

          <!-- Online panel -->
          <div class="panel">
            <div class="panelHeader">
              <div class="panelTitle">
                <span class="ico" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="M20 7c-3 3-13 3-16 0"/><path d="M4 7v10"/><path d="M20 7v10"/><path d="M7 17h10"/></svg>
                </span>
                <span style="min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Online</span>
              </div>
              <div class="panelRight">
                <span class="muted tiny" id="onlineCount">0</span>
                <button class="btn small ghost" id="onlineToggle" title="Collapse/Expand">
                  <span class="ico" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
                  </span>
                </button>
              </div>
            </div>
            <div class="panelBody scroll" id="onlineWrap">
              <div style="display:flex;flex-direction:column;gap:10px;padding:10px" id="onlineList"></div>
            </div>
          </div>

          <!-- Messages -->
          <div class="messagesPanel">
            <div class="sectionTitle">
              <div class="tight">
                <span class="ico" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>
                </span>
                <span>Messages</span>
              </div>

              <div class="tight">
                <div class="badge" id="msgPing">0</div>
                <button class="btn small primary" id="createGroupBtn">
                  <span class="ico" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
                  </span>
                  <span>Create</span>
                </button>
              </div>
            </div>

            <div class="scroll grow" style="padding:10px">
              <div style="display:flex;flex-direction:column;gap:10px" id="msgList"></div>
            </div>
          </div>
        </div>

        <div class="main">
          <div class="topbar">
            <div class="titleBlock grow">
              <div class="chatTitle" id="chatTitle">Global chat</div>
              <div class="chatHint" id="chatHint">shared with everyone</div>
            </div>

            <div class="mePill" id="mePill" title="Account menu">
              <div class="statusDot online" id="meStatusDot"></div>
              <div style="min-width:0">
                <div class="meName" id="meName">You</div>
                <div class="meSub" id="meSub">click for menu</div>
              </div>
              <span class="ico" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
              </span>
            </div>
          </div>

          <div class="chatBox" id="chatBox"></div>

          <div class="composer">
            <div class="cooldown" id="cooldownRow">
              <div id="cooldownText">0.0s</div>
              <div class="bar"><div class="barFill" id="cdFill"></div></div>
            </div>

            <div class="composerRow">
              <input class="field" id="message" placeholder="Type a message…" />
              <button class="btn primary" id="sendBtn">
                <span class="ico" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>
                </span>
                <span>Send</span>
              </button>
            </div>

            <div class="muted tiny" style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
              <div id="cooldownLabel">Cooldown: 3s</div>
              <div id="statusLabel">Status: Online</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Footer -->
  <div class="footer">
    <a href="https://ko-fi.com/fishy_x1" target="_blank" rel="noreferrer">Support on Ko-fi</a>
    <span>•</span>
    <span>© <span id="year"></span> All rights reserved</span>
  </div>

  <!-- Modal -->
  <div class="modalBack" id="modalBack">
    <div class="modal">
      <div class="modalTop">
        <div class="modalTitle" id="modalTitle">Modal</div>
        <button class="btn small" id="modalClose">
          <span class="ico" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg>
          </span>
          <span>Close</span>
        </button>
      </div>
      <div id="modalBody"></div>
    </div>
  </div>

  <!-- Toasts -->
  <div class="toasts" id="toasts"></div>

  <script src="/socket.io/socket.io.js"></script>
  <script src="/script.js"></script>
</body>
</html>
