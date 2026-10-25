const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const native=fs.readFileSync(path.join(__dirname,'../scripts/android-src/LshEmbeddedSurface.kt'),'utf8');
const script=native.match(/private val TAB_GESTURE_SCRIPT = """([\s\S]*?)    """\.trimIndent\(\)/)[1];
function harness(options={}){
 const handlers={},capture={},docHandlers={};let time=1000,selection=false,panel=false,modal=false,drawer=false,scroll=false,blocked=false;
 const target={isConnected:true,parentElement:null,scrollWidth:100,clientWidth:100,draggable:false,closest(selector){if(selector.startsWith('.lr-mobile-conversation'))return options.outside?null:this;return blocked?this:null;},getAttribute:()=>null};
 const document={documentElement:{dataset:{}},addEventListener:(n,f)=>docHandlers[n]=f,querySelector:()=>drawer?{}:null,querySelectorAll:()=>modal?[{getAttribute:()=>null,getClientRects:()=>[{}]}]:[]};
 const win={addEventListener:(n,f,o)=>(o?.capture?capture:handlers)[n]=f,getSelection:()=>({isCollapsed:!selection})};
 const context={window:win,document,innerWidth:400,innerHeight:600,performance:{now:()=>time},getComputedStyle:()=>({overflowX:scroll?'auto':'visible'})};
 vm.runInNewContext(script,context);
 const point=(x,y=200)=>({clientX:x,clientY:y,identifier:1});
 function event(type,x=200,y=200,extra={}){const e={isTrusted:true,defaultPrevented:false,target,touches:type==='touchend'?[]:[point(x,y)],changedTouches:[point(x,y)],...extra};capture[type]?.(e);handlers[type](e);return e;}
 return {event,tick:n=>time+=n,take:()=>win.__luckyrayTakeTabSwipe(),target,context,set(k,v){if(k==='selection')selection=v;if(k==='modal')modal=v;if(k==='drawer')drawer=v;if(k==='panel')document.documentElement.dataset.luckyrayMobilePanel=v?'1':'0';if(k==='scroll'){scroll=v;target.scrollWidth=v?500:100;}if(k==='blocked')blocked=v;},discard:()=>win.__luckyrayDiscardTabSwipe(),captureStart:()=>capture.touchstart(),cancel:()=>handlers.touchcancel(),hide:()=>docHandlers.visibilitychange()};
}
function swipe(h,x=250,end=120){h.event('touchstart',x);h.tick(150);h.event('touchmove',end);return h.event('touchend',end);}
test('fixed script allows one eligible horizontal direction and drains once',()=>{const h=harness();swipe(h);assert.equal(h.take(),'left');assert.equal(h.take(),'');swipe(h,120,250);assert.equal(h.take(),'right');});
test('nested horizontal owners, controls, selection, panels, dialogs and drawers reject',()=>{for(const key of ['scroll','blocked','selection','panel','modal','drawer']){const h=harness();h.set(key,true);swipe(h);assert.equal(h.take(),'',key);}const h=harness({outside:true});swipe(h);assert.equal(h.take(),'');});
test('edge, long press, vertical excursion and multi-touch reject',()=>{let h=harness();swipe(h,10,150);assert.equal(h.take(),'');h=harness();h.event('touchstart');h.tick(700);h.event('touchend',100);assert.equal(h.take(),'');h=harness();h.event('touchstart');h.event('touchmove',150,240);h.tick(100);h.event('touchend',100);assert.equal(h.take(),'');h=harness();h.event('touchstart',200,200,{touches:[{},{}]});h.tick(100);h.event('touchend',100);assert.equal(h.take(),'');});
test('late preventDefault, cancellation, hidden document and stale drain all reject',()=>{let h=harness(),e=swipe(h);e.defaultPrevented=true;assert.equal(h.take(),'');h=harness();swipe(h);h.cancel();assert.equal(h.take(),'');h=harness();swipe(h);h.hide();assert.equal(h.take(),'');h=harness();swipe(h);h.tick(251);assert.equal(h.take(),'');});
test('untrusted synthetic input and selection added after UP reject',()=>{let h=harness();h.event('touchstart',250,200,{isTrusted:false});h.tick(100);h.event('touchend',100);assert.equal(h.take(),'');h=harness();swipe(h);h.set('selection',true);assert.equal(h.take(),'');});
test('native drain is physically triggered and fenced without polling or broad bridge',()=>{
 // A suspended presentation consumes input; only a currently authorized,
 // ready presentation may observe a gesture and pass the touch to WebView.
 assert.match(native,/browser.setOnTouchListener \{ _, event -> if \(!inputAllowed\(\)\) true else \{ observeTabGesture\(browser, event\); false \} \}/);
 assert.match(native,/private fun inputAllowed\(\): Boolean = !suspended && presentationActive && ready && !failed && LshSurfaceBridge.isLeaseCurrent\(lease\)/);
 assert.match(native,/override fun onInterceptTouchEvent\(event: MotionEvent\): Boolean = !inputAllowed\(\) \|\| super.onInterceptTouchEvent\(event\)/);
 assert.match(native,/override fun dispatchKeyEvent\(event: KeyEvent\): Boolean = if \(!inputAllowed\(\)\) true else super.dispatchKeyEvent\(event\)/);
 assert.match(native,/elapsed in 40L\.\.600L/);assert.match(native,/MotionEvent.ACTION_POINTER_DOWN, MotionEvent.ACTION_CANCEL -> invalidateTabGesture/);
 const body=native.slice(native.indexOf('private fun observeTabGesture'),native.indexOf('private val CAPABILITY_SCRIPT'));
 for(const guard of ['gesture != gestureCounter','generation != pageGeneration','id != presentationId','activation != presentationActivation','currentLease != lease','!canDeliverTabGesture(view)'])assert(body.split(guard).length>=3,guard);
 assert.match(body,/raw != JSONObject.quote\(expected\)/);
 assert.match(body,/.put\("presentationActivation", activation\).put\("gestureId", gesture\)/);
 assert(!body.includes('.put("lease"'));assert(!native.includes('addJavascriptInterface'));
 assert(!script.includes('setInterval'));assert(!script.includes('preventDefault('));assert(!script.includes('fetch('));
});
test('capability preflight rejects missing syntax/APIs and preserves modern path',()=>{
 const code=native.match(/private val CAPABILITY_SCRIPT = """([^\n]+)"""/)[1];
 assert.deepEqual(Array.from(vm.runInNewContext(code)),[true,true,true,true,true]);
 assert.deepEqual(Array.from(vm.runInNewContext('Object.hasOwn=undefined;Array.prototype.at=undefined;String.prototype.replaceAll=undefined;WeakRef=undefined;'+code)),[true,false,false,false,false]);
 const context=vm.createContext({});vm.runInContext('Function=function(){throw new SyntaxError("static block unsupported")}',context);
 assert.equal(vm.runInContext(code,context)[0],false);
 assert(native.indexOf('probeCapabilities(view, pageGeneration)')<native.indexOf('probePresentation(view, pageGeneration'));
 assert.match(native,/failureCode = if \(!valid\) "LSH_PRESENTATION_PROBE_INVALID" else "LSH_WEBVIEW_UPDATE_REQUIRED"/);
 assert.match(native,/val launch = pendingCapabilityUrl\s+pendingCapabilityUrl = ""\s+view.loadUrl\(launch\)/);
});

test('late move takeover, detached target and stale prior-gesture pending reject',()=>{let h=harness();h.event('touchstart',250);h.tick(100);const move=h.event('touchmove',120);h.event('touchend',120);move.defaultPrevented=true;assert.equal(h.take(),'');h=harness();swipe(h);h.target.isConnected=false;assert.equal(h.take(),'');h=harness();swipe(h);h.discard();assert.equal(h.take(),'');});

test('capture only invalidates when a new inner touchstart never bubbles',()=>{const h=harness();h.event('touchstart',250);h.tick(100);h.captureStart();h.event('touchend',100);assert.equal(h.take(),'');});
