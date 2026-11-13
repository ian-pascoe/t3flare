// The harness panel's one stylesheet (ADR-0026), allowed by its SHA-256 hash in the CSP, so it is a constant: no
// interpolation, and no `style` attribute anywhere on the page (the CSP would refuse it).
//
// It echoes T3 Code's web client (SPI-1086) without importing it: t3's colour tokens (its zinc light theme and true-black
// dark theme, its hue-264 primary), its radii (0.5rem controls, 0.75rem groups), its settings layout (a quiet sidebar,
// 16px semibold section titles over grouped, divided rows with 14px titles and 12px descriptions) and its system font
// stack. Light and dark follow `prefers-color-scheme`.
export const STYLE = `:root{color-scheme:light dark;
--bg:#fcfcfc;--fg:#18181b;--card:#fff;--sidebar:#fafafa;--muted:#f4f4f5;--muted-fg:#71717a;--border:#e4e4e7;--row-border:#ececee;--input:#d4d4d8;
--hover:#f4f4f5;--selected:#fff;--primary:oklch(0.488 0.217 264);--primary-fg:#fff;--primary-soft:color-mix(in oklab,var(--primary) 10%,transparent);--ring:var(--primary);
--ok:#047857;--ok-dot:#10b981;--ok-soft:color-mix(in oklab,#10b981 12%,transparent);
--err:#b91c1c;--err-dot:#ef4444;--err-soft:color-mix(in oklab,#ef4444 8%,transparent);--err-line:color-mix(in oklab,#ef4444 28%,transparent);
--warn:#b45309;--warn-dot:#f59e0b;--warn-soft:color-mix(in oklab,#f59e0b 10%,transparent);--warn-line:color-mix(in oklab,#f59e0b 32%,transparent);
--shadow:0 1px 2px rgb(0 0 0/5%);--radius:.5rem;--radius-lg:.75rem;
--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;--mono:ui-monospace,"SF Mono","SFMono-Regular",Menlo,Consolas,"Liberation Mono",monospace;
--side-w:15rem;--content-w:50rem}
@media (prefers-color-scheme:dark){:root{
--bg:#000;--fg:#f5f5f5;--card:#121212;--sidebar:#0b0b0b;--muted:rgb(255 255 255/4%);--muted-fg:#a3a3a3;--border:rgb(255 255 255/9%);--row-border:rgb(255 255 255/6%);--input:rgb(255 255 255/14%);
--hover:rgb(255 255 255/5%);--selected:rgb(255 255 255/8%);--primary:oklch(0.571 0.21 264);--primary-soft:color-mix(in oklab,var(--primary) 22%,transparent);--ring:oklch(0.68 0.17 264);
--ok:#34d399;--ok-soft:color-mix(in oklab,#10b981 16%,transparent);--err:#f87171;--err-soft:color-mix(in oklab,#ef4444 13%,transparent);--err-line:color-mix(in oklab,#ef4444 34%,transparent);
--warn:#fbbf24;--warn-soft:color-mix(in oklab,#f59e0b 14%,transparent);--warn-line:color-mix(in oklab,#f59e0b 34%,transparent);--shadow:0 14px 32px -18px rgb(0 0 0/75%)}}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%;scroll-padding-top:1.5rem;accent-color:var(--primary)}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 var(--sans);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
::selection{background:color-mix(in oklab,var(--primary) 28%,transparent)}
h1,h2,h3,p,dl,dd,figure{margin:0}
h1,h2,h3{text-wrap:balance}
p{text-wrap:pretty}
a{color:inherit}
code,.mono{font-family:var(--mono);font-size:.8125rem}
svg.i{width:1rem;height:1rem;flex:none;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.skip{position:absolute;left:.75rem;top:-3rem;z-index:20;padding:.5rem .75rem;border-radius:var(--radius);background:var(--card);border:1px solid var(--border);text-decoration:none}
.skip:focus{top:.75rem}
.shell{display:grid;grid-template-columns:var(--side-w) minmax(0,1fr);min-height:100vh;background:linear-gradient(to right,var(--sidebar) calc(var(--side-w) - 1px),var(--border) 0 var(--side-w),transparent 0)}
.side{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:1.25rem;padding:1rem .75rem;background:var(--sidebar);border-right:1px solid var(--border)}
.brand{display:flex;align-items:center;gap:.625rem;padding:.25rem .5rem}
.brand-mark{display:grid;place-items:center;width:1.75rem;height:1.75rem;border-radius:var(--radius);background:var(--primary);color:var(--primary-fg)}
.brand-mark svg.i{width:1rem;height:1rem}
.brand strong{display:block;font-size:.875rem;font-weight:600;line-height:1.25}
.brand div span{display:block;font-size:.75rem;color:var(--muted-fg);line-height:1.25}
.nav{display:flex;flex-direction:column;gap:2px}
.nav a{display:flex;align-items:center;gap:.625rem;min-height:2rem;padding:.375rem .625rem;border-radius:var(--radius);color:var(--fg);text-decoration:none;font-weight:450;transition:background-color .15s}
.nav a svg.i{color:var(--muted-fg)}
.nav a:hover{background:var(--hover)}
.nav a[aria-current]{background:var(--selected);box-shadow:var(--shadow),inset 0 0 0 1px var(--border);font-weight:550}
.nav a[aria-current] svg.i{color:var(--primary)}
.nav .count{margin-left:auto;font-size:.6875rem;color:var(--muted-fg);font-variant-numeric:tabular-nums}
.nav .flag{margin-left:auto;width:.5rem;height:.5rem;border-radius:50%;background:var(--err-dot)}
.side-foot{margin-top:auto;padding:.5rem;font-size:.75rem;color:var(--muted-fg)}
.side-foot strong{color:var(--fg);font-weight:550;font-variant-numeric:tabular-nums}
main{min-width:0;padding:2.5rem 2rem 4rem}
.content{max-width:var(--content-w);margin:0 auto;display:flex;flex-direction:column;gap:2.5rem}
.page-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:.75rem 1.5rem}
.page-head h1{font-size:1.25rem;font-weight:600;letter-spacing:-.01em}
.page-head p{margin-top:.25rem;color:var(--muted-fg);max-width:36rem}
.chip{display:inline-flex;align-items:center;gap:.375rem;height:1.5rem;padding:0 .5rem;border-radius:999px;border:1px solid var(--border);background:var(--card);font-size:.75rem;color:var(--muted-fg);white-space:nowrap;font-variant-numeric:tabular-nums}
.chip strong{color:var(--fg);font-weight:550}
section{display:flex;flex-direction:column;gap:.625rem;scroll-margin-top:1.5rem}
.section-head{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:0 .25rem}
.section-head h2{display:flex;align-items:center;gap:.5rem;font-size:1rem;font-weight:600;min-height:1.75rem}
.section-head h2 svg.i{color:var(--muted-fg)}
.section-desc{padding:0 .25rem;margin-top:-.25rem;font-size:.75rem;color:var(--muted-fg);max-width:42rem}
.sub-head{padding:.5rem .25rem 0;font-size:.75rem;font-weight:550;color:var(--muted-fg)}
.group{border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--card);box-shadow:var(--shadow);min-width:0}
.group>*+*{border-top:1px solid var(--row-border)}
.row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:.75rem 2rem;padding:.875rem 1rem}
.row-title{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem .5rem;min-height:1.25rem}
.row-title h3{font-size:.875rem;font-weight:550}
.ident{font-family:var(--mono);font-size:.6875rem;color:var(--muted-fg)}
.desc{margin-top:.125rem;font-size:.75rem;line-height:1.5;color:var(--muted-fg);max-width:40rem}
.row-control{display:flex;align-items:center;justify-content:flex-end;gap:.5rem}
.row-extra{grid-column:1/-1;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.75rem 2rem;align-items:start;padding-top:.25rem}
.fields{display:flex;flex-direction:column;gap:.875rem;max-width:30rem}
.save{display:flex;align-items:center;gap:.75rem;padding-top:calc(1.21875rem + .375rem + 4px)}
.state{display:inline-flex;align-items:center;gap:.375rem;font-size:.75rem;color:var(--muted-fg);white-space:nowrap}
.state svg.i{width:.875rem;height:.875rem}
.core .row{padding:.625rem 1rem}
.field{display:flex;flex-direction:column;gap:.375rem;min-width:0}
.field>label,.field>.label,fieldset>legend{font-size:.8125rem;font-weight:550}
.field .hint{font-size:.75rem;color:var(--muted-fg)}
.inline-field{display:flex;align-items:center;gap:.625rem;flex-wrap:wrap}
.inline-field label{font-size:.8125rem;font-weight:500}
input[type=text],input[type=url],input[type=password],input[type=number],select{height:2.25rem;padding:0 .625rem;border:1px solid var(--input);border-radius:var(--radius);background:var(--card);color:var(--fg);font:inherit;font-size:.875rem;transition:border-color .15s,box-shadow .15s}
input[type=number]{width:7.5rem;font-variant-numeric:tabular-nums}
textarea{min-height:5rem;width:100%;padding:.5rem .625rem;border:1px solid var(--input);border-radius:var(--radius);background:var(--card);color:var(--fg);font:inherit;font-size:.875rem;resize:vertical}
.field input[type=text]{width:100%}
select{padding-right:2rem;appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--muted-fg) 50%),linear-gradient(135deg,var(--muted-fg) 50%,transparent 50%);background-position:calc(100% - 15px) 52%,calc(100% - 10px) 52%;background-size:5px 5px;background-repeat:no-repeat;min-width:10rem}
input::placeholder{color:color-mix(in oklab,var(--muted-fg) 80%,transparent)}
input:hover,select:hover,textarea:hover{border-color:color-mix(in oklab,var(--input) 60%,var(--muted-fg))}
input:focus-visible,select:focus-visible,textarea:focus-visible{outline:none;border-color:var(--ring);box-shadow:0 0 0 3px color-mix(in oklab,var(--ring) 28%,transparent)}
input:user-invalid{border-color:var(--err)}
input:disabled,select:disabled,textarea:disabled{opacity:.64;cursor:not-allowed}
.btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:.375rem;height:2rem;padding:0 .75rem;border:1px solid var(--input);border-radius:var(--radius);background:var(--card);color:var(--fg);font:inherit;font-size:.8125rem;font-weight:500;white-space:nowrap;cursor:pointer;text-decoration:none;box-shadow:0 1px 1px rgb(0 0 0/4%);transition:background-color .15s,border-color .15s,color .15s,transform .1s}
.btn:hover{background:var(--hover)}
.btn:active{transform:scale(.97)}
.btn:disabled{opacity:.64;cursor:not-allowed;transform:none}
.btn svg.i{width:.875rem;height:.875rem}
.btn-primary{background:var(--primary);border-color:var(--primary);color:var(--primary-fg);box-shadow:inset 0 1px rgb(255 255 255/16%),0 1px 2px color-mix(in oklab,var(--primary) 24%,transparent)}
.btn-primary:hover{background:color-mix(in oklab,var(--primary) 90%,var(--bg))}
.btn-ghost{border-color:transparent;background:transparent;box-shadow:none;color:var(--muted-fg)}
.btn-ghost:hover{background:var(--hover);color:var(--fg)}
.btn-danger{border-color:transparent;background:transparent;box-shadow:none;color:var(--muted-fg)}
.btn-danger:hover{background:var(--err-soft);color:var(--err)}
.btn-sm{height:1.75rem;padding:0 .5rem;font-size:.75rem}
.btn[aria-busy=true]{color:transparent}
.btn[aria-busy=true]::after{content:"";position:absolute;inset:0;margin:auto;width:.875rem;height:.875rem;border-radius:50%;border:2px solid var(--muted-fg);border-right-color:transparent;animation:spin .7s linear infinite}
.btn-primary[aria-busy=true]::after{border-color:var(--primary-fg);border-right-color:transparent}
@keyframes spin{to{transform:rotate(1turn)}}
.switch{position:relative;display:inline-flex;align-items:center;flex:none;width:2.25rem;height:1.25rem;padding:2px;border:0;border-radius:999px;background:var(--input);cursor:pointer;transition:background-color .2s}
.switch::before{content:"";width:1rem;height:1rem;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgb(0 0 0/20%);transition:transform .2s cubic-bezier(.32,.72,0,1)}
.switch:is([aria-checked=true],:checked){background:var(--primary)}
.switch:is([aria-checked=true],:checked)::before{transform:translateX(1rem)}
input.switch{appearance:none;margin:0}
.switch:disabled,.switch[aria-busy=true]{opacity:.64;cursor:progress}
.pill{display:inline-flex;align-items:center;gap:.375rem;height:1.375rem;padding:0 .5rem;border-radius:999px;font-size:.6875rem;font-weight:550;white-space:nowrap;background:var(--muted);color:var(--muted-fg)}
.pill::before{content:"";width:.375rem;height:.375rem;border-radius:50%;background:currentColor}
.pill-ok{background:var(--ok-soft);color:var(--ok)}
.pill-err{background:var(--err-soft);color:var(--err)}
.pill-warn{background:var(--warn-soft);color:var(--warn)}
.pill-plain::before{display:none}
.tag{display:inline-flex;align-items:center;height:1.25rem;padding:0 .375rem;border-radius:.3125rem;border:1px solid var(--border);font-size:.6875rem;font-weight:500;color:var(--muted-fg);white-space:nowrap}
.tag-read{color:var(--ok);border-color:color-mix(in oklab,var(--ok-dot) 30%,transparent);background:var(--ok-soft)}
.tag-write{color:var(--warn);border-color:var(--warn-line);background:var(--warn-soft)}
.stack{display:flex;flex-direction:column;gap:.75rem}
.server-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.75rem 1rem;align-items:start;padding:1rem}
.server-name{display:flex;flex-wrap:wrap;align-items:center;gap:.375rem .5rem}
.server-name h3{font-size:.9375rem;font-weight:600}
.server-url{margin-top:.25rem;font-family:var(--mono);font-size:.75rem;color:var(--muted-fg);overflow-wrap:anywhere}
.facts{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:.375rem 1.25rem;font-size:.75rem;color:var(--muted-fg)}
.facts>div{display:flex;align-items:center;gap:.375rem}
.facts dt{font-weight:400}
.facts dd{color:var(--fg);font-variant-numeric:tabular-nums}
.facts dd .ident,.facts dd code{font-size:inherit}
.callout{display:flex;gap:.625rem;align-items:flex-start;margin:0 1rem 1rem;padding:.625rem .75rem;border-radius:var(--radius);border:1px solid var(--err-line);background:var(--err-soft);font-size:.8125rem}
.callout svg.i{margin-top:.125rem;color:var(--err)}
.callout strong{display:block;font-weight:550}
.callout p,.callout li{color:var(--fg);overflow-wrap:anywhere}
.callout .mono{font-size:.75rem}
.callout-warn{border-color:var(--warn-line);background:var(--warn-soft)}
.callout-warn svg.i{color:var(--warn)}
.callout ul{margin:.25rem 0 0;padding-left:1rem}
.server-actions{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;padding:.625rem 1rem}
.server-actions .spacer{flex:1}
.test-result{display:flex;align-items:center;gap:.375rem;font-size:.75rem;color:var(--muted-fg)}
.test-result:empty{display:none}
.test-result[data-tone=ok]{color:var(--ok)}
.test-result[data-tone=err]{color:var(--err)}
details.tools>summary{display:flex;align-items:center;gap:.5rem;padding:.625rem 1rem;cursor:pointer;list-style:none;font-size:.8125rem;font-weight:550}
details.tools>summary::-webkit-details-marker{display:none}
details.tools>summary svg.i{color:var(--muted-fg);transition:transform .15s}
details.tools[open]>summary svg.i{transform:rotate(90deg)}
details.tools>summary span{font-weight:400;color:var(--muted-fg)}
details.tools>summary:hover{background:var(--hover)}
.empty-tools{padding:.75rem 1rem;font-size:.75rem;color:var(--muted-fg)}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.8125rem}
th{padding:.5rem 1rem;text-align:left;font-size:.6875rem;font-weight:550;color:var(--muted-fg);background:var(--muted);border-bottom:1px solid var(--row-border);white-space:nowrap}
td{padding:.5rem 1rem;border-bottom:1px solid var(--row-border);vertical-align:top}
tr:last-child>td{border-bottom:0}
tbody tr:hover>td{background:color-mix(in oklab,var(--hover) 60%,transparent)}
td.num,.num{font-variant-numeric:tabular-nums}
td .src{display:block;margin-top:.125rem;font-size:.6875rem;color:var(--muted-fg)}
td.actions{text-align:right;white-space:nowrap}
.change{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;font-size:.6875rem;color:var(--muted-fg);overflow-wrap:anywhere;max-width:22rem}
.when{white-space:nowrap;color:var(--muted-fg);font-variant-numeric:tabular-nums}
.who{white-space:nowrap}
form.add{display:flex;flex-direction:column}
.form-body{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;padding:1rem}
.form-body .wide{grid-column:1/-1}
.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}
fieldset{margin:0;padding:0;border:0;min-width:0}
fieldset>legend{padding:0;margin-bottom:.375rem}
.choices{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.5rem}
.choice{position:relative;display:flex;gap:.625rem;align-items:flex-start;padding:.625rem .75rem;border:1px solid var(--input);border-radius:var(--radius);cursor:pointer;transition:border-color .15s,background-color .15s}
.choice:hover{background:var(--hover)}
.choice input{margin:.1875rem 0 0}
.choice strong{display:block;font-size:.8125rem;font-weight:550}
.choice span{display:block;font-size:.75rem;color:var(--muted-fg)}
.choice:has(input:checked){border-color:var(--primary);background:var(--primary-soft)}
.choice:has(input:focus-visible){outline:2px solid var(--ring);outline-offset:2px}
.choice input:focus-visible{outline:none}
.form-foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.75rem;padding:.75rem 1rem;background:var(--muted);border-bottom-left-radius:var(--radius-lg);border-bottom-right-radius:var(--radius-lg)}
.form-foot p{font-size:.75rem;color:var(--muted-fg);display:flex;align-items:center;gap:.375rem}
.empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:.375rem;padding:2rem 1.5rem}
.empty .empty-icon{display:grid;place-items:center;width:2.25rem;height:2.25rem;margin-bottom:.25rem;border-radius:var(--radius);background:var(--muted);color:var(--muted-fg)}
.empty h3{font-size:.875rem;font-weight:550}
.empty p{font-size:.75rem;color:var(--muted-fg);max-width:26rem}
dl.kv>div{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;padding:.625rem 1rem}
dl.kv dt{color:var(--muted-fg);font-size:.8125rem}
dl.kv dd{text-align:right;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.notice{display:flex;align-items:flex-start;gap:.625rem;padding:.75rem 1rem;border-radius:var(--radius-lg);border:1px solid var(--border);background:var(--card);box-shadow:var(--shadow);font-size:.8125rem}
.notice[hidden]{display:none}
.notice[data-tone=err]{border-color:var(--err-line);background:var(--err-soft)}
.notice[data-tone=err] svg.i{color:var(--err)}
.notice[data-tone=ok] svg.i{color:var(--ok)}
.notice .msg{flex:1;white-space:pre-wrap;overflow-wrap:anywhere}
.notice .btn{margin:-.25rem -.5rem -.25rem 0}
.notice-ico-ok,.notice-ico-err{display:none}
.notice[data-tone=ok] .notice-ico-ok,.notice[data-tone=err] .notice-ico-err{display:inline}
.save-note{font-size:.75rem;color:var(--muted-fg)}
.save-note:empty{display:none}
@media (max-width:860px){
.shell{grid-template-columns:minmax(0,1fr);background:none}
.side{position:sticky;top:0;z-index:10;height:auto;flex-direction:column;gap:.5rem;padding:.625rem .75rem .5rem;border-right:0;border-bottom:1px solid var(--border);background:color-mix(in oklab,var(--sidebar) 94%,transparent);backdrop-filter:saturate(1.1) blur(12px)}
.brand{padding:0 .25rem}
.nav{flex-direction:row;gap:.25rem;overflow-x:auto;scrollbar-width:none;margin:0 -.75rem;padding:0 .75rem .125rem}
.nav::-webkit-scrollbar{display:none}
.nav a{flex:none;min-height:2.25rem;padding:.375rem .75rem}
.nav .count,.nav .flag{margin-left:.125rem}
.side-foot{display:none}
main{padding:1.5rem 1rem 3rem}
html{scroll-padding-top:7rem}
section{scroll-margin-top:7rem}
.content{gap:2rem}
}
@media (max-width:640px){
body{font-size:15px}
input[type=text],input[type=url],input[type=password],input[type=number],select{font-size:16px;height:2.75rem}
.btn{height:2.5rem;padding:0 .875rem;font-size:.875rem}
.btn-sm{height:2.25rem;padding:0 .625rem;font-size:.8125rem}
.row{grid-template-columns:minmax(0,1fr);gap:.625rem}
.row-control{justify-content:flex-start}
.row>.row-control:has(.switch){position:absolute;right:1rem;top:.875rem}
.row:has(>.row-control .switch){position:relative;padding-right:4.25rem}
.row-extra{grid-template-columns:minmax(0,1fr)}
.save{padding-top:0}
.fields{max-width:none}
.inline-field{display:grid;grid-template-columns:minmax(0,1fr) auto}
.server-head{grid-template-columns:minmax(0,1fr) auto}
.form-body,.pair{grid-template-columns:minmax(0,1fr)}
.choices{grid-template-columns:minmax(0,1fr)}
.switch{width:2.75rem;height:1.5rem}
.switch::before{width:1.25rem;height:1.25rem}
.switch:is([aria-checked=true],:checked)::before{transform:translateX(1.25rem)}
table.stacked thead{display:none}
table.stacked,table.stacked tbody,table.stacked tr,table.stacked td{display:block;width:100%}
table.stacked tr{padding:.625rem 1rem;border-bottom:1px solid var(--row-border)}
table.stacked tr:last-child{border-bottom:0}
table.stacked td{display:grid;grid-template-columns:5.5rem minmax(0,1fr);gap:.75rem;padding:.1875rem 0;border:0;text-align:left}
table.stacked td::before{content:attr(data-label);font-size:.6875rem;font-weight:550;color:var(--muted-fg);padding-top:.125rem}
table.stacked td.actions{white-space:normal}
table.tools-table tr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.25rem .75rem;align-items:center}
table.tools-table td{display:block;padding:0}
table.tools-table td::before{display:none}
table.tools-table td.tool{grid-column:1/-1;font-weight:550}
table.tools-table td.cls>div{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem}
table.tools-table td.cls .src{display:inline;margin:0}
table.tools-table td.exp{grid-row:3;font-size:.75rem;color:var(--muted-fg)}
table.tools-table td.exp>div::before{content:"Exposure "}
table.tools-table td.actions{grid-column:2;grid-row:2/4;text-align:right}
table.tools-table td.actions>div{display:flex;flex-direction:column;align-items:flex-end;gap:.25rem}
table.stacked tbody tr:hover>td{background:none}
.change{max-width:none}
}
@media (pointer:coarse){.btn-sm{min-height:2.25rem}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition-duration:0s!important;animation-duration:1.5s!important}}
@media (forced-colors:active){.switch{border:1px solid ButtonText}.switch::before{background:ButtonText}.pill,.tag{border:1px solid}}`;
