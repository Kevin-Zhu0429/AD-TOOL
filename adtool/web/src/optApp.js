/**
 * 广告优化工作台 · 界面层
 * 从单文件版「批量表工作台 V7」移植:原来的整页应用改成挂在一个容器上的模块,
 * 所有 DOM 查询都限定在挂载根里(页面用 Shadow DOM 挂载,和站内样式互不干扰)。
 */
import * as XLSX from 'xlsx';
import * as C from './optCore.js';
import * as NL from './negLib.js';

const MARKUP = `
<div class="app">
  <div class="topbar">
    <div class="brand"><b>广告优化</b><span>SP BULK</span></div>
    <div class="viewsw"><span class="vbtn on" data-view="work">按活动优化</span><span class="vbtn" data-view="analysis">数据分析</span></div>
    <div class="filechip" id="chipA">
      <span class="tag">本期</span>
      <span class="nm" id="fileAName">未载入</span>
      <input class="period" id="periodA" placeholder="周期 如 7.24-7.30">
    </div>
    <div class="spacer"></div>
    <button class="btn" id="btnLoadA">载入本期批量表</button>
    <button class="btn ghost" id="btnLoadS">载入搜索词报告</button>
    <button class="btn ghost" id="btnBneg">批量否定</button>
    <button class="btn ghost" id="btnSet">规则设置</button>
    <button class="btn pri" id="btnExport">导出批量表</button>
  </div>
  <div class="cmyk"><i></i><i></i><i></i><i></i></div>

  <div class="kpibar" id="kpibar" style="display:none"></div>

  <div class="main" id="main" style="display:none">
    <div class="rail">
      <div class="railhead">
        <input class="srch" id="search" placeholder="搜活动名 / 组合 / SKU / 关键词">
        <div class="chips" id="chips">
          <span class="chip on" data-f="all">全部</span>
          <span class="chip bad" data-f="bad">危险</span>
          <span class="chip warn" data-f="warn">关注</span>
          <span class="chip" data-f="spend">有花费</span>
          <span class="chip" data-f="noimp">零曝光</span>
          <span class="chip" data-f="paused">已暂停</span>
          <span class="chip" data-f="dirty">已改动</span>
        </div>
        <div class="railmeta">
          <select id="pf"><option value="">全部广告组合</option></select>
          <select id="sort">
            <option value="spend">花费 ↓</option>
            <option value="acos">ACOS ↓</option>
            <option value="imp">曝光 ↓</option>
            <option value="clicks">点击 ↓</option>
            <option value="orders">订单 ↓</option>
            <option value="name">名称 A–Z</option>
          </select>
        </div>
        <div class="sub muted" id="railCount" style="font-size:10px;margin-top:5px"></div>
      </div>
      <div class="raillist" id="raillist"></div>
    </div>

    <div class="detail" id="detail"></div>
  </div>

  <div class="analysis" id="analysis" style="display:none">
    <div class="antabs" id="antabs"></div>
    <div class="anbody" id="anbody"></div>
  </div>

  <div class="drop" id="drop">
    <div class="dropinner">
      <div class="dropbox" id="dropbox">
        <h2>把批量表拖进来</h2>
        <p>或点击「载入本期批量表」。文件只在你自己的浏览器里解析，不会上传到任何服务器。</p>
        <button class="btn pri" id="btnLoadA2">选择 .xlsx 文件</button>
        <ol class="steps">
          <li>后台路径：广告 → 批量操作 → 下载广告活动</li>
          <li>日期范围选好你要复盘的周期，勾选你需要的Sheet</li>
          <li>建议同时勾上搜索词报告，工作台里可以一键否定</li>
          <li>优化完点右上角导出，得到的表直接回后台上传</li>
        </ol>
      </div>
    </div>
  </div>

  <div class="footbar" id="footbar" style="display:none">
    <span class="chgcount zero" id="chgCount">0 处改动</span>
    <button class="btn sm" id="btnChanges">查看变更清单</button>
    <button class="btn sm" id="btnUndoAll">全部撤销</button>
    <div class="spacer"></div>
    <button class="btn sm" id="btnSaveProg">保存进度</button>
    <button class="btn sm" id="btnLoadProg">载入进度</button>
    <button class="btn sm" id="btnCsv">导出变更清单 CSV</button>
    <button class="btn pri" id="btnExport2">导出批量表</button>
  </div>
</div>

<div class="mask" id="maskSet"><div class="modal" style="max-width:560px">
  <header><h3>规则设置</h3><div class="spacer" style="flex:1"></div><button class="btn sm" data-close>关闭</button></header>
  <div class="body">
    <div class="setgrid">
      <div class="h">异常判定阈值</div>
      <label>目标 ACOS（超过标红）</label><input type="number" id="s_acos" step="1">
      <label>零单花费红线</label><input type="number" id="s_zspend" step="0.1">
      <label>零单点击红线</label><input type="number" id="s_zclick" step="1">
      <label>低点击率阈值 %</label><input type="number" id="s_ctr" step="0.01">
      <label>低转化率阈值 %（有单但转化偏低）</label><input type="number" id="s_cvr" step="1">
      <div class="h">SKU 矩阵标记</div>
      <label>转化率低于 %（配合下面的 ACOS 一起标红）</label><input type="number" id="s_skucvr" step="1">
      <label>且 ACOS 高于 %</label><input type="number" id="s_skuacos" step="0.5">
      <label>点击数达到多少仍零转化 → 标蓝</label><input type="number" id="s_skudead" step="1">
      <div class="h">导出</div>
      <label>枚举值写法</label>
      <select id="s_vocab"><option value="">跟随原表</option><option value="zh">中文（更新/已暂停）</option><option value="en">英文（Update/paused）</option></select>
      <label>导出范围</label>
      <select id="s_scope"><option value="changed">仅改动行（推荐）</option><option value="all">完整表（未改动行留空操作列）</option></select>
      <label>货币符号</label><input type="text" id="s_cur" style="text-align:center">
      <div class="hint">枚举值默认跟随你下载的批量表语言。若上传被后台拒收，换一种写法再导一次即可。</div>
    </div>
  </div>
  <footer><button class="btn" data-close>取消</button><button class="btn pri" id="setSave">保存并重算</button></footer>
</div></div>

<div class="mask" id="maskBneg"><div class="modal" style="max-width:1180px">
  <header><h3>批量否定</h3><span class="muted">把一批否定词一次性加到多个广告活动</span><div style="flex:1"></div><button class="btn sm" data-close>关闭</button></header>
  <div class="body">
    <div class="bnwrap">
      <div class="bnleft">
        <span class="lbl">自己填的否定词</span>
        <textarea id="bnText" rows="7" placeholder="一行一个，也可以用逗号分隔&#10;&#10;305&#10;hp 305 xl&#10;canon 545, canon 546"></textarea>
        <div class="bnopts">
          <div><span class="lbl">匹配方式</span><select id="bnMatch"><option value="phrase">否定词组</option><option value="exact">否定精准匹配</option></select></div>
          <div><span class="lbl">否定范围</span><select id="bnScope">
            <option value="campaign">活动级（每个活动一条，推荐）</option>
            <option value="adgroup">广告组级（活动下每个广告组各一条）</option>
          </select></div>
        </div>
        <div class="bnsub">这两项管的是自己填的词；从词库来的词默认跟词库里设的走。</div>
      </div>
      <div class="bnlib">
        <div class="bnlibhead"><span class="lbl">从否定词库取词</span><span class="muted" id="bnLibMk"></span></div>
        <div id="bnLibBody"></div>
      </div>
      <div class="bnright">
        <span class="lbl">选择广告活动</span>
        <div class="bnbar"><input type="text" id="bnSrch" placeholder="搜活动名 / 组合"><select id="bnPf"></select></div>
        <div class="bnbar">
          <button class="btn sm" data-bnsel="all">全选当前列表</button>
          <button class="btn sm" data-bnsel="none">清空</button>
          <button class="btn sm" data-bnsel="rail">同左栏筛选</button>
          <button class="btn sm" data-bnsel="spend">只选有花费</button>
          <button class="btn sm" data-bnsel="enabled">只选已启用</button>
        </div>
        <div class="bnlist" id="bnList"></div>
      </div>
    </div>
  </div>
  <footer><span id="bnSum" class="muted"></span><div style="flex:1"></div><button class="btn" data-close>取消</button><button class="btn pri" id="bnGo">加入变更清单</button></footer>
</div></div>

<div class="mask" id="maskChg"><div class="modal">
  <header><h3>变更清单</h3><span class="muted" id="chgSum"></span><div style="flex:1"></div><button class="btn sm" data-close>关闭</button></header>
  <div class="body" id="chgBody"></div>
  <footer><button class="btn" id="chgUndoAll">全部撤销</button><button class="btn" id="chgCsv">导出 CSV</button><button class="btn pri" id="chgExport">导出批量表</button></footer>
</div></div>

<div class="mask" id="maskExp"><div class="modal" style="max-width:620px">
  <header><h3>导出批量表</h3><div style="flex:1"></div><button class="btn sm" data-close>关闭</button></header>
  <div class="body" id="expBody"></div>
  <footer><button class="btn" data-close>再检查一下</button><button class="btn pri" id="expGo">生成文件</button></footer>
</div></div>

<div class="toast" id="toast"></div>
<input type="file" id="fileA" accept=".xlsx,.xls" style="display:none">
<input type="file" id="fileS" accept=".xlsx,.xls,.csv" style="display:none">
<input type="file" id="fileP" accept=".json" style="display:none">
`;

/**
 * 把工作台挂到 root 上(document 片段或 shadowRoot 都行)。
 * host 是接收拖拽的那个元素。
 * 返回 { unmount, setLibrary } —— 站点否定词库由外面的 React 页面拉好再送进来,
 * 批量否定就能直接用词库里的词。
 */
export function mountOptimizer(root, host) {
  root.innerHTML = MARKUP;

  // 挂在 window / host 上的监听要能收回,离开这一页时不留东西
  const offs = [];
  const on = (el, ev, fn) => { el.addEventListener(ev, fn); offs.push(() => el.removeEventListener(ev, fn)); };

  var S = {
    model:null, raw:null, fileName:'',
    changes:new C.ChangeSet(), cfg:Object.assign({},C.DEFAULT_CFG),
    cur:'€', vocab:'', scope:'changed',
    sel:null, tab:'placement', filter:'all', pf:'', sort:'spend', q:'',
    // terms 是搜索词原始行(按天下载的报告一个词有很多行),上界面前合并成整期一行
    terms:[], periodTouched:false,
    checked:{}, stAll:false, stTgt:'', expT:{}, stRptName:'', bnSel:{}, bnQ:'', bnPf:'',
    // 否定词库(站点级,页面挂载后由 setLibrary 送进来)和批量否定里的选词状态
    lib:null, libErr:'', market:'',
    bnLib:{on:{},follow:true,q:'',off:{},models:[],only:'both',mq:'',ver:0,_sig:'',_all:[]},
    view:'work', an:{tab:'sku',byAsin:false,q:'',pf:'',minClicks:0,mark:'',tf:'',kf:'',exp:{},stSel:{},
      skuSub:{},skuExcl:{},sku:'',skuOnlyEx:false,_skuStList:[],adSel:{},_skuAds:[],
      sort:{sku:{k:'clicks',d:-1},term:{k:'spend',d:-1},kw:{k:'spend',d:-1},pf:{k:'spend',d:-1}}}
  };
  var $=function(s){return root.querySelector(s)}, $$=function(s){return Array.prototype.slice.call(root.querySelectorAll(s))};

  /* ---------- 格式化 ---------- */
  function fi(n){return (n||0).toLocaleString('en-US')}
  function fm(n){return S.cur+(n||0).toFixed(2)}
  function fp(n,d){if(!isFinite(n))return '—';return ((n||0)*100).toFixed(d===undefined?1:d)+'%'}
  function facos(m){if(m.sales>0)return fp(m.acos,1); return m.spend>0?'无销售':'—'}
  function esc(s){return String(s===null||s===undefined?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function toast(msg){var t=$('#toast');t.textContent=msg;t.classList.add('on');clearTimeout(t._t);t._t=setTimeout(function(){t.classList.remove('on')},2200)}

  /* ---------- 状态词表 ---------- */
  function stateWords(){ return (C.VOCAB[S.model?S.model.lang:'zh']||C.VOCAB.zh).state }
  function stateLabel(k){ return {enabled:'已启用',paused:'已暂停',archived:'已存档'}[k]||k }

  /* ---------- 载入 ---------- */
  function readFile(file, cb){
    var fr=new FileReader();
    fr.onload=function(e){ try{ cb(new Uint8Array(e.target.result)); }catch(err){ alert('解析失败：'+err.message); } };
    fr.onerror=function(){ alert('文件读取失败'); };
    fr.readAsArrayBuffer(file);
  }
  function loadMain(file){
    readFile(file,function(bytes){
      try{
        var m=C.parse(bytes);
        S.model=m; S.raw=bytes; S.fileName=file.name; S.changes=new C.ChangeSet();
        S.periodTouched=false; S.stRptName='';
        setTerms(m.searchTerms||[]);
        autoPeriodLabel(file.name);
        if(m.currency) S.cur=m.currency==='EUR'?'€':(m.currency==='USD'?'$':(m.currency==='GBP'?'£':m.currency+' '));
        S.sel=null; S.checked={}; S.an.exp={}; S.an.stSel={}; S.an.q=''; setView('work');
        $('#fileAName').textContent=file.name;
        $('#drop').style.display='none'; $('#main').style.display='grid';
        $('#kpibar').style.display='flex'; $('#footbar').style.display='flex';
        buildPortfolios(); renderAll();
        toast('已载入 '+m.campaigns.length+' 条广告活动');
      }catch(err){ alert('解析失败：'+err.message); }
    });
  }

  /* ---------- 事件：载入 ---------- */
  $('#btnLoadA').onclick=$('#btnLoadA2').onclick=function(){$('#fileA').click()};
  $('#fileA').onchange=function(e){ if(e.target.files[0]){ if(S.changes.count()&&!confirm('当前有 '+S.changes.count()+' 处未导出的改动，重新载入会丢失。继续？'))return; loadMain(e.target.files[0]); } e.target.value=''; };
  $('#btnLoadS').onclick=function(){ if(!S.model){toast('先载入本期批量表');return;} $('#fileS').click(); };
  $('#fileS').onchange=function(e){ if(e.target.files[0]) loadSearchReport(e.target.files[0]); e.target.value=''; };
  function loadSearchReport(file){
    readFile(file,function(bytes){
      try{
        var res=C.parseSearchTermReport(bytes,S.model);
        if(!res.matched){ alert('报告解析成功，但没有一条能匹配到当前批量表里的广告活动。请确认两份文件来自同一个店铺。'); return; }
        mergeStReport({terms:res.terms,file:file.name,matched:res.matched,unmatched:res.unmatched});
      }catch(err){ alert('搜索词报告解析失败：'+err.message); }
    });
  }
  ['dragenter','dragover'].forEach(function(ev){on(host,ev,function(e){e.preventDefault();$('#dropbox')&&$('#dropbox').classList.add('dragover')})});
  ['dragleave','drop'].forEach(function(ev){on(host,ev,function(e){e.preventDefault();$('#dropbox')&&$('#dropbox').classList.remove('dragover')})});
  on(host,'drop',function(e){
    var f=e.dataTransfer.files[0]; if(!f)return;
    if(/\.json$/i.test(f.name)) return loadProgress(f);
    if(!S.model){ loadMain(f); return; }
    if(S.changes.count()&&!confirm('当前有 '+S.changes.count()+' 处未导出的改动，换表会丢失。继续？'))return;
    loadMain(f);
  });

  /* ---------- 全店 KPI ---------- */
  function renderKpi(){
    var t=C.totals(S.model);
    var items=[
      ['曝光',fi(t.imp),''],['点击',fi(t.clicks),''],['点击率',fp(t.ctr,2),''],
      ['CPC',S.cur+t.cpc.toFixed(3),''],['花费',fm(t.spend),''],['订单',fi(t.orders),''],
      ['转化率',fp(t.cvr,1),''],['销售额',fm(t.sales),''],['ACOS',fp(t.acos,2),''],['ROAS',t.roas.toFixed(2),'']
    ];
    $('#kpibar').innerHTML=items.map(function(x){
      return '<div class="kpi"><div class="k">'+x[0]+'</div><div class="v">'+x[1]+'</div>'+(x[2]||'')+'</div>';
    }).join('')+'<div class="kpi" style="border:0"><div class="k">活动 / 广告组</div><div class="v">'+S.model.campaigns.length+' / '+S.model.campaigns.reduce(function(a,c){return a+c.adGroups.length},0)+'</div></div>';
  }

  /* ---------- 活动列表 ---------- */
  function campLevel(cp){ return C.worstLevel(C.flagsFor('campaign',cp.m,{},S.cfg)) }
  function campDirty(cp){
    var ids={}; [cp.row].concat(cp.adGroups.map(g=>g.row),cp.placements.map(p=>p.row),cp.ads.map(a=>a.row),cp.targets.map(t=>t.row),cp.negatives.map(n=>n.row)).forEach(function(r){ if(r)ids[r.i]=1 });
    var hit=Object.keys(S.changes.edits).some(function(k){return ids[k]});
    if(hit)return true;
    return S.changes.creates.some(function(n){return n.campaignId===cp.id});
  }
  function buildPortfolios(){
    var set={}; S.model.campaigns.forEach(function(c){ if(c.portfolio)set[c.portfolio]=1 });
    $('#pf').innerHTML='<option value="">全部广告组合</option>'+Object.keys(set).sort().map(function(p){return '<option>'+esc(p)+'</option>'}).join('');
  }
  function filteredCamps(){
    var q=S.q.toLowerCase();
    return S.model.campaigns.filter(function(cp){
      if(S.pf&&cp.portfolio!==S.pf)return false;
      var lv=campLevel(cp);
      if(S.filter==='bad'&&lv!=='bad')return false;
      if(S.filter==='warn'&&lv!=='warn')return false;
      if(S.filter==='spend'&&cp.m.spend<=0)return false;
      if(S.filter==='noimp'&&cp.m.imp>0)return false;
      if(S.filter==='paused'&&cp.state!=='paused')return false;
      if(S.filter==='dirty'&&!campDirty(cp))return false;
      if(q){
        var hay=(cp.name+' '+cp.portfolio).toLowerCase();
        if(hay.indexOf(q)<0){
          var deep=cp.ads.some(function(a){return String(a.sku).toLowerCase().indexOf(q)>=0||String(a.asin).toLowerCase().indexOf(q)>=0})||
                   cp.targets.some(function(t){return String(t.text).toLowerCase().indexOf(q)>=0});
          if(!deep)return false;
        }
      }
      return true;
    }).sort(function(a,b){
      if(S.sort==='name')return a.name.localeCompare(b.name);
      if(S.sort==='acos'){var x=a.m.sales>0?a.m.acos:(a.m.spend>0?99:-1),y=b.m.sales>0?b.m.acos:(b.m.spend>0?99:-1);return y-x}
      return b.m[S.sort]-a.m[S.sort];
    });
  }
  function renderRail(){
    var list=filteredCamps();
    $('#railCount').textContent=list.length+' / '+S.model.campaigns.length+' 条活动 · 合计花费 '+fm(list.reduce(function(a,c){return a+c.m.spend},0));
    $('#raillist').innerHTML=list.map(function(cp){
      var lv=campLevel(cp);
      return '<div class="crow lv-'+lv+(S.sel===cp.id?' sel':'')+(cp.state==='paused'?' paused':'')+'" data-id="'+cp.id+'">'+
        (campDirty(cp)?'<span class="edited-mark">改</span>':'')+
        '<div class="nm"><span class="dot '+lv+'"></span>'+esc(cp.name)+'</div>'+
        '<div class="sub">'+esc(cp.portfolio||'无组合')+' · '+esc(cp.targetingType||'-')+' · '+esc(cp.strategy||'-')+'</div>'+
        '<div class="figs"><span>曝 <b>'+fi(cp.m.imp)+'</b></span><span>点 <b>'+fi(cp.m.clicks)+'</b></span>'+
        '<span>花 <b>'+fm(cp.m.spend)+'</b></span>'+
        '<span>单 <b>'+fi(cp.m.orders)+'</b></span><span>A <b>'+facos(cp.m)+'</b></span></div>'+
      '</div>';
    }).join('')||'<div class="empty">没有符合条件的活动</div>';
  }
  $('#raillist').addEventListener('click',function(e){
    var row=e.target.closest('.crow'); if(!row)return;
    S.sel=row.dataset.id; S.checked={}; S.stTgt=''; S.expT={}; renderRail(); renderDetail();
    $('#detail').scrollTop=0;
  });
  $('#search').addEventListener('input',function(e){S.q=e.target.value.trim();renderRail()});
  $('#pf').onchange=function(e){S.pf=e.target.value;renderRail()};
  $('#sort').onchange=function(e){S.sort=e.target.value;renderRail()};
  $('#chips').addEventListener('click',function(e){
    var c=e.target.closest('.chip'); if(!c)return;
    $$('#chips .chip').forEach(function(x){x.classList.remove('on')}); c.classList.add('on');
    S.filter=c.dataset.f; renderRail();
  });

  /* ---------- 详情 ---------- */
  function curVal(row,col){ return C.cur(S.model,S.changes,row,col) }
  function isDirty(row,col){ return S.changes.get(row.i,col)!==undefined }
  function setVal(row,col,val,field){
    var orig=row.d[col];
    S.changes.set(row.i,col,orig,val,field);
    renderFoot(); renderRail();
  }
  function numInput(row,col,field,step,min){
    var v=curVal(row,col);
    return '<input class="cellin'+(isDirty(row,col)?' dirty':'')+'" type="number" step="'+(step||0.01)+'" min="'+(min===undefined?0:min)+'" value="'+(v===null||v===undefined?'':v)+'" data-ri="'+row.i+'" data-col="'+col+'" data-field="'+field+'">';
  }
  function stateSelect(row){
    var c=S.model.colIdx, w=stateWords(), cv=C.normState(curVal(row,c.state));
    return '<select class="cellsel'+(isDirty(row,c.state)?' dirty':'')+'" data-ri="'+row.i+'" data-col="'+c.state+'" data-field="state" data-map="state">'+
      ['enabled','paused','archived'].map(function(k){return '<option value="'+w[k]+'"'+(cv===k?' selected':'')+'>'+stateLabel(k)+'</option>'}).join('')+'</select>';
  }
  function flagsHtml(fl){ return fl.map(function(f){return '<span class="flagchip '+f.level+'">'+esc(f.text)+'</span>'}).join('') }


  function renderDetail(){
    var host=$('#detail');
    if(!S.sel){ host.innerHTML='<div class="empty">左边选一条广告活动</div>'; return; }
    var cp=S.model.byCamp[S.sel], c=S.model.colIdx;
    var m=cp.m;
    var kpis=[['曝光',fi(m.imp),''],['点击',fi(m.clicks),''],['点击率',fp(m.ctr,2),''],
      ['CPC',S.cur+m.cpc.toFixed(3),''],['花费',fm(m.spend),''],['订单',fi(m.orders),''],
      ['转化率',fp(m.cvr,1),''],['销售额',fm(m.sales),''],['ACOS',facos(m),''],['ROAS',m.roas.toFixed(2),'']];

    var head='<div class="dhead">'+
      '<div class="dtitle">'+esc(cp.name)+'</div>'+
      '<div class="dmeta"><span class="tag cy">'+esc(cp.portfolio||'无组合')+'</span><span class="tag">'+esc(cp.targetingType||'-')+'</span>'+
        '<span class="tag">'+esc(cp.strategy||'-')+'</span><span class="muted mono">ID '+esc(cp.id)+'</span>'+
        '<span class="muted">开始 '+esc(cp.startDate||'-')+'</span></div>'+
      '<div class="dctrl">'+
        (cp.row?'<div class="field"><label>活动状态</label>'+stateSelect(cp.row)+'</div>':'')+
        (cp.row&&c.dailyBudget>=0?'<div class="field"><label>每日预算</label>'+numInput(cp.row,c.dailyBudget,'dailyBudget',0.5,1)+'</div>':'')+
        cp.adGroups.map(function(g){ return c.defaultBid>=0&&g.row?'<div class="field"><label>组默认竞价 · '+esc(g.name.slice(0,18))+'</label>'+numInput(g.row,c.defaultBid,'defaultBid',0.01,0.02)+'</div>':''}).join('')+
      '</div>'+
      '<div class="dkpi">'+kpis.map(function(x){return '<div class="kpi"><div class="k">'+x[0]+'</div><div class="v">'+x[1]+'</div>'+(x[2]||'')+'</div>'}).join('')+'</div>'+
    '</div>';

    var tabs=[['placement','广告位',cp.placements.length],['sku','SKU',cp.ads.length],
              ['target','投放',cp.targets.length],['neg','否定',cp.negatives.length],
              ['st','搜索词',stForCamp(cp.id).length]];
    var tabbar='<div class="tabs">'+tabs.map(function(t){
      return '<div class="tab'+(S.tab===t[0]?' on':'')+'" data-tab="'+t[0]+'">'+t[1]+'<span class="cnt">'+t[2]+'</span></div>';
    }).join('')+'</div>';

    host.innerHTML=head+diagHtml(cp)+tabbar+'<div class="tabbody" id="tabbody">'+tabHtml(cp)+'</div>';
  }

  /* ---------- 诊断提示 ---------- */
  function diagHtml(cp){
    var rows=[];
    cp.ads.forEach(function(a){ var f=C.flagsFor('productAd',a.m,{eligible:a.eligible},S.cfg); if(f.length&&a.m.spend>0) rows.push({t:'SKU',o:a.sku,m:a.m,f:f}) });
    cp.targets.forEach(function(t){ var f=C.flagsFor(t.kind,t.m,{},S.cfg); if(f.length&&t.m.spend>0) rows.push({t:t.kind==='keyword'?'关键词':'商品投放',o:t.text,m:t.m,f:f}) });
    cp.placements.forEach(function(pl){ var f=C.flagsFor('bidAdj',pl.m,{},S.cfg); if(f.length) rows.push({t:'广告位',o:pl.label,m:pl.m,f:f}) });
    rows.sort(function(a,b){return b.m.spend-a.m.spend});
    rows=rows.slice(0,8);
    if(!rows.length)return '';
    return '<div class="diag"><h4>本活动待处理</h4><ul>'+rows.map(function(r){
      return '<li><span class="tag">'+r.t+'</span><span class="obj">'+esc(String(r.o).slice(0,46))+'</span>'+
        '<span class="mono muted">'+fi(r.m.clicks)+'#'+fi(r.m.orders)+' · 转化 '+fp(r.m.cvr,1)+' · '+fm(r.m.spend)+'</span>'+
        flagsHtml(r.f.slice(0,2))+'</li>';
    }).join('')+'</ul></div>';
  }

  /* ---------- 各 Tab ---------- */
  function tabHtml(cp){
    if(S.tab==='placement')return placementTab(cp);
    if(S.tab==='sku')return skuTab(cp);
    if(S.tab==='target')return targetTab(cp);
    if(S.tab==='neg')return negTab(cp);
    return stTab(cp);
  }
  function baseBid(cp){
    var g=cp.adGroups[0];
    var b=g&&g.row&&S.model.colIdx.defaultBid>=0?C.num(curVal(g.row,S.model.colIdx.defaultBid)):0;
    if(b>0.03)return b;
    var bids=cp.targets.map(function(t){return C.num(t.bid)}).filter(function(x){return x>0});
    return bids.length?bids.reduce(function(a,b2){return a+b2},0)/bids.length:b;
  }
  function placementTab(cp){
    var c=S.model.colIdx, bb=baseBid(cp);
    var order={top:0,ros:1,pp:2,biz:3,other:4};
    var list=cp.placements.slice().sort(function(a,b){return order[a.key]-order[b.key]});
    if(!list.length)return '<div class="empty">这条活动没有广告位溢价行</div>';
    return '<table class="tbl"><thead><tr><th>广告位</th><th class="r">溢价 %</th><th class="r">理论落地 CPC</th>'+
      '<th class="r">曝光</th><th class="r">点击</th><th class="r">点击率</th><th class="r">花费</th><th class="r">订单</th>'+
      '<th class="r">转化率</th><th class="r">销售额</th><th class="r">ACOS</th><th class="r">CPC</th><th>提示</th></tr></thead><tbody>'+
      list.map(function(pl){
        var f=C.flagsFor('bidAdj',pl.m,{},S.cfg), lv=C.worstLevel(f);
        var pct=C.num(curVal(pl.row,c.percentage));
        var theo=bb*(1+pct/100);

        return '<tr class="lv-'+lv+'"><td class="nmcell"><b>'+esc(pl.label)+'</b></td>'+
          '<td class="num">'+numInput(pl.row,c.percentage,'percentage',5,0)+'</td>'+
          '<td class="num">'+(bb?S.cur+theo.toFixed(3):'—')+'</td>'+
          '<td class="num">'+fi(pl.m.imp)+'</td><td class="num">'+fi(pl.m.clicks)+'</td><td class="num">'+fp(pl.m.ctr,2)+'</td>'+
          '<td class="num">'+fm(pl.m.spend)+'</td><td class="num">'+fi(pl.m.orders)+'</td><td class="num">'+fp(pl.m.cvr,1)+'</td>'+
          '<td class="num">'+fm(pl.m.sales)+'</td><td class="num">'+facos(pl.m)+'</td><td class="num">'+S.cur+pl.m.cpc.toFixed(3)+'</td>'+
          '<td>'+flagsHtml(f)+'</td></tr>';
      }).join('')+'</tbody></table>'+
      '<div class="toolrow"><span class="muted">理论落地 CPC = 基础竞价 '+(bb?S.cur+bb.toFixed(2):'未知')+' ×（1 + 溢价），用来估这个位置实际会出到多少钱。</span></div>';
  }
  function checkbox(key,id){ return '<input type="checkbox" data-ck="'+key+'" data-id="'+id+'"'+(S.checked[id]?' checked':'')+'>' }
  function checkedCount(){ return Object.keys(S.checked).filter(function(k){return S.checked[k]}).length }
  function refreshBatch(kind){
    var bh=$('#batchHost'); if(bh)bh.innerHTML=batchBarHtml(kind||S.tab);
  }
  function batchBar(kind){ return '<div id="batchHost">'+batchBarHtml(kind)+'</div>' }
  function batchBarHtml(kind){
    var n=checkedCount();
    if(!n)return '';
    return '<div class="batchbar"><b>'+n+'</b> 项已选'+
      '<button class="btn sm" data-batch="pause">暂停</button>'+
      '<button class="btn sm" data-batch="enable">启用</button>'+
      (kind==='target'?'<button class="btn sm" data-batch="bid-10">竞价 −10%</button><button class="btn sm" data-batch="bid-20">竞价 −20%</button>'+
        '<button class="btn sm" data-batch="bid+10">竞价 +10%</button>'+
        '<span style="margin-left:6px">设为 <input type="number" step="0.01" id="batchBid" style="width:70px" class="cellin"> </span>'+
        '<button class="btn sm" data-batch="bid-set">应用</button>':'')+
      '<div style="flex:1"></div><button class="btn sm" data-batch="clear">取消选择</button></div>';
  }
  function skuTab(cp){
    var c=S.model.colIdx;
    if(!cp.ads.length)return '<div class="empty">这条活动没有 SKU 广告行</div>';
    var list=cp.ads.slice().sort(function(a,b){return b.m.spend-a.m.spend||b.m.imp-a.m.imp});
    return batchBar('sku')+'<table class="tbl"><thead><tr><th><input type="checkbox" data-ckall="sku"></th><th>SKU</th><th>ASIN</th><th>广告组</th><th>状态</th>'+
      '<th class="r">曝光</th><th class="r">点击</th><th class="r">点击率</th><th class="r">花费</th><th class="r">订单</th>'+
      '<th class="r">转化率</th><th class="r">销售额</th><th class="r">ACOS</th><th class="r">CPC</th><th>提示</th></tr></thead><tbody>'+
      list.map(function(a){
        var f=C.flagsFor('productAd',a.m,{eligible:a.eligible},S.cfg), lv=C.worstLevel(f);
        var st=C.normState(curVal(a.row,c.state));
        return '<tr class="lv-'+lv+(st==='enabled'?'':' paused')+'"><td>'+checkbox('sku',a.row.i)+'</td>'+
          '<td class="nmcell mono" style="font-size:11px">'+esc(a.sku)+'</td><td class="mono muted" style="font-size:11px">'+esc(a.asin)+'</td>'+
          '<td class="muted" title="'+esc(a.adGroupName)+'" style="font-size:11px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(a.adGroupName)+'</td>'+
          '<td>'+stateSelect(a.row)+'</td>'+
          '<td class="num">'+fi(a.m.imp)+'</td><td class="num">'+fi(a.m.clicks)+'</td><td class="num">'+fp(a.m.ctr,2)+'</td>'+
          '<td class="num">'+fm(a.m.spend)+'</td><td class="num">'+fi(a.m.orders)+'</td><td class="num">'+fp(a.m.cvr,1)+'</td>'+
          '<td class="num">'+fm(a.m.sales)+'</td><td class="num">'+facos(a.m)+'</td><td class="num">'+S.cur+a.m.cpc.toFixed(3)+'</td>'+
          '<td>'+flagsHtml(f)+(a.eligible?'':'<span class="flagchip bad">'+esc(a.eligibilityText)+'</span>')+'</td></tr>';
      }).join('')+'</tbody></table>';
  }
  function targetTab(cp){
    var c=S.model.colIdx;
    if(!cp.targets.length)return '<div class="empty">这条活动没有关键词或商品投放行</div>';
    var list=cp.targets.slice().sort(function(a,b){return b.m.spend-a.m.spend||b.m.imp-a.m.imp});
    var hasSt=S.model.searchTerms.length>0;
    S._stList=[];
    return batchBar('target')+'<table class="tbl"><thead><tr><th><input type="checkbox" data-ckall="target"></th><th>投放</th><th>匹配</th><th>广告组</th><th>状态</th><th class="r">竞价</th>'+
      '<th class="r">曝光</th><th class="r">点击</th><th class="r">点击率</th><th class="r">花费</th><th class="r">订单</th>'+
      '<th class="r">转化率</th><th class="r">销售额</th><th class="r">ACOS</th><th class="r">CPC</th>'+(hasSt?'<th>搜索词</th>':'')+'<th>提示</th></tr></thead><tbody>'+
      list.map(function(t){
        var f=C.flagsFor(t.kind,t.m,{},S.cfg), lv=C.worstLevel(f);
        var st=C.normState(curVal(t.row,c.state));
        var bidCol=t.row.d[c.bid]!==null&&t.row.d[c.bid]!==undefined?numInput(t.row,c.bid,'bid',0.01,0.02):'<span class="muted">组默认</span>';
        return '<tr class="lv-'+lv+(st==='enabled'?'':' paused')+'"><td>'+checkbox('target',t.row.i)+'</td>'+
          '<td class="nmcell" style="max-width:230px;word-break:break-all">'+esc(t.text)+'</td>'+
          '<td><span class="tag">'+esc(t.matchType)+'</span></td>'+
          '<td class="muted" title="'+esc(t.adGroupName)+'" style="font-size:11px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(t.adGroupName)+'</td>'+
          '<td>'+stateSelect(t.row)+'</td><td class="num">'+bidCol+'</td>'+
          '<td class="num">'+fi(t.m.imp)+'</td><td class="num">'+fi(t.m.clicks)+'</td><td class="num">'+fp(t.m.ctr,2)+'</td>'+
          '<td class="num">'+fm(t.m.spend)+'</td><td class="num">'+fi(t.m.orders)+'</td><td class="num">'+fp(t.m.cvr,1)+'</td>'+
          '<td class="num">'+fm(t.m.sales)+'</td><td class="num">'+facos(t.m)+'</td><td class="num">'+S.cur+t.m.cpc.toFixed(3)+'</td>'+
          (hasSt?'<td>'+stCell(t)+'</td>':'')+
          '<td>'+flagsHtml(f)+'</td></tr>'+(hasSt&&S.expT[t.id]?subRow(t,hasSt):'');
      }).join('')+'</tbody></table>';
  }
  function stCell(t){
    var n=stForTarget(t.id).length;
    if(!n)return '<span class="muted">—</span>';
    return '<button class="expbtn'+(S.expT[t.id]?' on':'')+'" data-expt="'+esc(t.id)+'">'+(S.expT[t.id]?'收起':'搜索词')+' '+n+'</button>';
  }
  function subRow(t,hasSt){
    var sub=stForTarget(t.id);
    var body=sub.map(function(s){ var i=S._stList.length; S._stList.push(s); return stRow(s,i) }).join('');
    var tot=sub.reduce(function(a,s){return {sp:a.sp+s.m.spend,ck:a.ck+s.m.clicks,od:a.od+s.m.orders}},{sp:0,ck:0,od:0});
    return '<tr class="subrow"><td colspan="'+(hasSt?17:16)+'"><div class="subwrap">'+
      '<div class="subcap"><b>「'+esc(t.text)+'」跑出的顾客搜索词</b><span>'+sub.length+' 个词 · '+
      tot.ck+' 点击 '+tot.od+' 单 · 花费 '+fm(tot.sp)+'</span></div>'+
      '<table class="sub"><thead><tr><th>顾客搜索词</th><th class="r">曝光</th><th class="r">点击</th><th class="r">点击率</th>'+
      '<th class="r">花费</th><th class="r">订单</th><th class="r">转化率</th><th class="r">销售额</th><th class="r">ACOS</th><th>否定</th></tr></thead>'+
      '<tbody>'+body+'</tbody></table></div></td></tr>';
  }
  function negTab(cp){
    var c=S.model.colIdx;
    var pend=S.changes.creates.filter(function(n){return n.campaignId===cp.id});
    var groups=cp.adGroups.map(function(g){return '<option value="'+esc(g.id)+'">'+esc(g.name)+'</option>'}).join('');
    var form='<div class="negform">'+
      '<div class="negleft"><span class="lbl">否定词</span>'+
        '<textarea id="negText" rows="5" placeholder="一行一个，也可以用逗号分隔，支持整段粘贴&#10;&#10;305&#10;hp 305 xl&#10;canon 545, canon 546"></textarea>'+
        '<div class="neghint">一次可以贴很多个词，重复的会自动跳过。要删掉已有的否定词，把下面表里那一行的状态改成「已存档」。'+
        '要按站点否定词库整类否，点右边的「批量否定到多个活动…」。</div></div>'+
      '<div class="negright">'+
        '<div><span class="lbl">匹配方式</span><select id="negMatch"><option value="phrase">否定词组</option><option value="exact">否定精准匹配</option></select></div>'+
        '<div><span class="lbl">否定范围</span><select id="negScope"><option value="adgroup">广告组级</option><option value="campaign">活动级</option></select></div>'+
        '<div><span class="lbl">广告组</span><select id="negGroup">'+groups+'</select></div>'+
        '<button class="btn pri" id="negAdd" style="color:#fff">添加到变更清单</button>'+
        '<button class="btn" id="negBulk">批量否定到多个活动…</button>'+
      '</div></div>';
    var pendHtml=pend.length?'<table class="tbl"><thead><tr><th>待新增否定词</th><th>匹配</th><th>范围</th><th>广告组</th><th></th></tr></thead><tbody>'+
      pend.map(function(n){return '<tr><td class="nmcell"><b>'+esc(n.text)+'</b></td><td><span class="tag cy">'+
        (n.kind==='negTarget'?'商品定向':n.match==='exact'?'否定精准':'否定词组')+'</span></td>'+
        '<td>'+(n.kind==='campNegKw'?'活动级':'广告组级')+'</td><td class="muted">'+esc(n.adGroupName||'-')+'</td>'+
        '<td><button class="btn sm" data-rmneg="'+n._id+'">撤销</button></td></tr>'}).join('')+'</tbody></table>':'';
    var exist=cp.negatives.length?'<table class="tbl"><thead><tr><th>已有否定</th><th>类型</th><th>匹配</th><th>范围</th><th>广告组</th><th>状态</th></tr></thead><tbody>'+
      cp.negatives.slice().sort(function(a,b){return String(a.text).localeCompare(String(b.text))}).map(function(n){
        var st=C.normState(curVal(n.row,c.state));
        return '<tr'+(st==='enabled'?'':' class="paused"')+'><td class="nmcell" style="word-break:break-all">'+esc(n.text)+'</td>'+
          '<td class="muted">'+(n.kind==='negTarget'?'商品':'关键词')+'</td><td><span class="tag">'+esc(n.matchType||'-')+'</span></td>'+
          '<td>'+(n.scope==='campaign'?'活动级':'广告组级')+'</td>'+
          '<td class="muted" title="'+esc(n.adGroupName||'-')+'" style="font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(n.adGroupName||'-')+'</td>'+
          '<td>'+stateSelect(n.row)+'</td></tr>';
      }).join('')+'</tbody></table>':'<div class="empty">这条活动还没有否定词</div>';
    return form+pendHtml+exist;
  }
  function stForCamp(id){ return S.model.searchTerms.filter(function(s){return s.campaignId===id}) }
  function stIndex(){
    if(!S.model._stIdx){
      var idx={};
      S.model.searchTerms.forEach(function(s){ var k=s.targetId||''; (idx[k]=idx[k]||[]).push(s); });
      Object.keys(idx).forEach(function(k){ idx[k].sort(function(a,b){return b.m.spend-a.m.spend||b.m.clicks-a.m.clicks}) });
      S.model._stIdx=idx;
    }
    return S.model._stIdx;
  }
  function stForTarget(tid){ return (tid&&stIndex()[tid])||[] }
  function stRow(s,i){
    return '<tr><td style="max-width:280px;word-break:break-all">'+esc(s.term)+'</td>'+
      '<td class="num">'+fi(s.m.imp)+'</td><td class="num">'+fi(s.m.clicks)+'</td><td class="num">'+fp(s.m.ctr,2)+'</td>'+
      '<td class="num">'+fm(s.m.spend)+'</td><td class="num">'+fi(s.m.orders)+'</td><td class="num">'+fp(s.m.cvr,1)+'</td>'+
      '<td class="num">'+fm(s.m.sales)+'</td><td class="num">'+facos(s.m)+'</td>'+
      '<td>'+(alreadyNegated(s.campaignId,s.term)?'<span class="flagchip good">已加入否定</span>':
        '<button class="btn sm" data-neg="'+i+'" data-match="phrase">词组</button> '+
        '<button class="btn sm" data-neg="'+i+'" data-match="exact">精准</button>')+'</td></tr>';
  }
  /**
   * 搜索词那几张表每一行都要问一次「这个词加过否定没有」,
   * 而变更清单在词库批量否定之后可能有上万条,所以按变更清单的状态建一次索引再查。
   */
  function negatedIdx(){
    var sig=S.changes.creates.length+'|'+S.changes.seq;
    if(S._negSig!==sig){
      var m={};
      S.changes.creates.forEach(function(n){ m[n.campaignId+'|'+String(n.text).toLowerCase()]=1 });
      S._negSig=sig; S._negIdx=m;
    }
    return S._negIdx;
  }
  function alreadyNegated(campaignId,text){
    return !!negatedIdx()[campaignId+'|'+String(text).toLowerCase()];
  }
  function stTab(cp){
    if(!S.model.searchTerms.length)
      return '<div class="empty">这份批量表里没有搜索词报告。<br>下载批量文件时勾选「搜索词报告」，或者点右上角「载入搜索词报告」把后台单独导出的报告合并进来。</div>';
    var all=S.stAll, list=all?S.model.searchTerms.slice():stForCamp(cp.id);
    if(!all&&S.stTgt)list=list.filter(function(s){return s.targetId===S.stTgt});
    list.sort(function(a,b){return b.m.spend-a.m.spend||b.m.clicks-a.m.clicks});
    S._stList=list;
    var tgtOpts='';
    if(!all){
      var idx=stIndex();
      tgtOpts='<select id="stTgt"><option value="">全部投放</option>'+
        cp.targets.filter(function(t){return (idx[t.id]||[]).length}).sort(function(a,b){return (idx[b.id]||[]).length-(idx[a.id]||[]).length})
          .map(function(t){return '<option value="'+esc(t.id)+'"'+(S.stTgt===t.id?' selected':'')+'>'+esc(String(t.text).slice(0,40))+'（'+(idx[t.id]||[]).length+'）</option>'}).join('')+
        '</select>';
    }
    var bar='<div class="toolrow"><label><input type="checkbox" id="stAll"'+(all?' checked':'')+'> 显示全部活动的搜索词</label>'+tgtOpts+
      '<span class="muted">共 '+list.length+' 条 · 花费 '+fm(list.reduce(function(a,s){return a+s.m.spend},0))+'</span>'+
      '<div style="flex:1"></div><span class="muted">点「否定」直接写进变更清单</span></div>';
    if(!list.length)return bar+'<div class="empty">这条活动本期没有搜索词数据</div>';
    return bar+'<table class="tbl"><thead><tr><th>顾客搜索词</th><th>来源投放</th><th>匹配</th>'+(all?'<th>活动</th>':'<th>广告组</th>')+
      '<th class="r">曝光</th><th class="r">点击</th><th class="r">点击率</th><th class="r">花费</th><th class="r">订单</th>'+
      '<th class="r">转化率</th><th class="r">销售额</th><th class="r">ACOS</th><th>否定</th></tr></thead><tbody>'+
      list.map(function(s,i){
        var f=C.flagsFor('st',s.m,{},S.cfg), lv=C.worstLevel(f);
        return '<tr class="lv-'+lv+'"><td class="nmcell" style="max-width:250px;word-break:break-all">'+esc(s.term)+'</td>'+
          '<td class="muted" title="'+esc(s.keywordText)+'" style="font-size:12px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(s.keywordText)+'</td>'+
          '<td><span class="tag">'+esc(s.matchType||'-')+'</span></td>'+
          '<td class="muted" title="'+esc(all?s.campaignName:s.adGroupName)+'" style="font-size:12px;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(all?s.campaignName:s.adGroupName)+'</td>'+
          '<td class="num">'+fi(s.m.imp)+'</td><td class="num">'+fi(s.m.clicks)+'</td><td class="num">'+fp(s.m.ctr,2)+'</td>'+
          '<td class="num">'+fm(s.m.spend)+'</td><td class="num">'+fi(s.m.orders)+'</td><td class="num">'+fp(s.m.cvr,1)+'</td>'+
          '<td class="num">'+fm(s.m.sales)+'</td><td class="num">'+facos(s.m)+'</td>'+
          '<td>'+(alreadyNegated(s.campaignId,s.term)
            ? '<span class="flagchip good">已加入否定</span>'
            : '<button class="btn sm" data-neg="'+i+'" data-match="phrase">词组</button> '+
              '<button class="btn sm" data-neg="'+i+'" data-match="exact">精准</button>')+'</td></tr>';
      }).join('')+'</tbody></table>';
  }

  /* ---------- 详情区事件 ---------- */
  $('#detail').addEventListener('click',function(e){
    var tab=e.target.closest('.tab');
    if(tab){ S.tab=tab.dataset.tab; S.checked={}; renderDetail(); return; }
    var ex=e.target.closest('[data-expt]');
    if(ex){ var id=ex.dataset.expt; if(S.expT[id])delete S.expT[id]; else S.expT[id]=1;
      $('#tabbody').innerHTML=tabHtml(S.model.byCamp[S.sel]); return; }
    var b=e.target.closest('[data-batch]');
    if(b){ doBatch(b.dataset.batch); return; }
    var rm=e.target.closest('[data-rmneg]');
    if(rm){ S.changes.removeCreate(+rm.dataset.rmneg); renderFoot(); renderDetail(); renderRail(); return; }
    if(e.target.id==='negAdd'){ addNegFromForm(); return; }
    if(e.target.id==='negBulk'){ S.bnSel[S.sel]=1; openBneg(); return; }
    var ng=e.target.closest('[data-neg]');
    if(ng){
      var s=S._stList[+ng.dataset.neg]; if(!s)return;
      var ok=S.changes.addNegative({kind:'negKeyword',campaignId:s.campaignId,adGroupId:s.adGroupId,text:s.term,
        match:ng.dataset.match,campaignName:s.campaignName,adGroupName:s.adGroupName});
      toast(ok?'已加入否定：'+s.term:'这个否定词已经加过了');
      renderFoot(); renderRail();
      ng.closest('td').innerHTML='<span class="flagchip good">已加入否定</span>';
      if(S.tab==='neg')renderDetail();
      return;
    }
  });
  $('#detail').addEventListener('change',function(e){
    var el=e.target;
    if(el.id==='stAll'){ S.stAll=el.checked; S.stTgt=''; $('#tabbody').innerHTML=tabHtml(S.model.byCamp[S.sel]); return; }
    if(el.id==='stTgt'){ S.stTgt=el.value; $('#tabbody').innerHTML=tabHtml(S.model.byCamp[S.sel]); return; }
    if(el.dataset.ckall!==undefined){
      $$('#tabbody [data-ck]').forEach(function(b){ b.checked=el.checked; S.checked[b.dataset.id]=el.checked; });
      refreshBatch(el.dataset.ckall); return;
    }
    if(el.dataset.ck!==undefined){ S.checked[el.dataset.id]=el.checked; refreshBatch(el.dataset.ck); return; }
    if(el.dataset.ri!==undefined){
      var row=S.model.rows[+el.dataset.ri], col=+el.dataset.col, field=el.dataset.field;
      var val=el.dataset.map==='state'?el.value:(el.value===''?null:parseFloat(el.value));
      if(field==='percentage'&&val!==null)val=Math.round(val);
      setVal(row,col,val,field);
      el.classList.toggle('dirty',S.changes.get(row.i,col)!==undefined);
      if(field==='percentage'||field==='defaultBid')renderDetail();
      return;
    }
  });
  function addNegFromForm(){
    var cp=S.model.byCamp[S.sel];
    var txt=$('#negText').value.trim(); if(!txt){toast('先填否定词');return;}
    var match=$('#negMatch').value, scope=$('#negScope').value, gid=$('#negGroup').value;
    var gname=(cp.adGroups.filter(function(g){return g.id===gid})[0]||{}).name||'';
    var n=0;
    txt.split(/[,，\n]/).map(function(x){return x.trim()}).filter(Boolean).forEach(function(w){
      if(S.changes.addNegative({kind:scope==='campaign'?'campNegKw':'negKeyword',campaignId:cp.id,adGroupId:gid,
        text:w,match:match,campaignName:cp.name,adGroupName:gname}))n++;
    });
    $('#negText').value='';
    toast(n?('已加入 '+n+' 个否定词'):'这些词都加过了');
    renderFoot(); renderRail(); renderDetail();
  }
  function doBatch(op){
    var c=S.model.colIdx, w=stateWords();
    var ids=Object.keys(S.checked).filter(function(k){return S.checked[k]});
    if(op==='clear'){ S.checked={}; renderDetail(); return; }
    var setBid=null;
    if(op==='bid-set'){ setBid=parseFloat($('#batchBid').value); if(!(setBid>0)){toast('先填竞价');return;} }
    ids.forEach(function(i){
      var row=S.model.rows[+i];
      if(op==='pause')setVal(row,c.state,w.paused,'state');
      else if(op==='enable')setVal(row,c.state,w.enabled,'state');
      else if(op.indexOf('bid')===0){
        var base=C.num(curVal(row,c.bid)); if(!base&&op!=='bid-set')return;
        var v=op==='bid-set'?setBid:(op==='bid-10'?base*0.9:op==='bid-20'?base*0.8:base*1.1);
        v=Math.max(0.02,Math.round(v*100)/100);
        setVal(row,c.bid,v,'bid');
      }
    });
    toast('已批量处理 '+ids.length+' 项');
    S.checked={}; renderDetail();
  }

  /* ---------- 批量否定 ---------- */
  var BN_TERM_MAX=300, BN_MODEL_MAX=160;

  function bnMatchSame(raw,match){
    var t=String(raw||'');
    return match==='exact' ? /精准|exact/i.test(t) : /词组|phrase/i.test(t);
  }
  function bnCamps(){
    var q=S.bnQ.toLowerCase();
    return S.model.campaigns.filter(function(cp){
      if(S.bnPf&&cp.portfolio!==S.bnPf)return false;
      if(q&&(cp.name+' '+cp.portfolio).toLowerCase().indexOf(q)<0)return false;
      return true;
    }).sort(function(a,b){return b.m.spend-a.m.spend});
  }
  function bnWords(){
    var seen={},out=[];
    ($('#bnText').value||'').split(/[,，\n]/).forEach(function(x){
      var w=x.trim(); if(!w)return;
      var k=w.toLowerCase(); if(seen[k])return; seen[k]=1; out.push(w);
    });
    return out;
  }

  /* ---------- 批量否定 · 词库 ---------- */
  function bnLibOn(){ return Object.keys(S.bnLib.on).filter(function(k){return S.bnLib.on[k]}) }
  /**
   * 选中的几类词库能出的全部词(还没减掉界面上取消勾选的)。
   * 整库出词不便宜,而且填一个字就要重算一次汇总,所以按选择状态缓存住。
   */
  function bnLibAll(){
    if(!S.lib)return [];
    var sel={
      on:S.bnLib.on, follow:S.bnLib.follow,
      match:$('#bnMatch').value, scope:$('#bnScope').value,
      models:S.bnLib.models, only:S.bnLib.only
    };
    var sig=S.bnLib.ver+'|'+bnLibOn().sort().join(',')+'|'+(sel.follow?'f':sel.match+sel.scope)+
            '|'+sel.only+'|'+S.bnLib.models.join(',');
    if(S.bnLib._sig!==sig){ S.bnLib._sig=sig; S.bnLib._all=NL.libEntries(S.lib,sel); }
    return S.bnLib._all;
  }
  /** 真正要否的那些:减掉手动取消勾选的词 */
  function bnLibPicked(){
    return bnLibAll().filter(function(en){ return !S.bnLib.off[NL.entryKey(en)] });
  }
  /** 自己填的词 + 词库挑中的词,合成一张待否定清单 */
  function bnEntries(){
    var match=$('#bnMatch').value, scope=$('#bnScope').value;
    var out=[],seen={};
    var push=function(en){
      var k=(en.asin?'a|':'k|')+String(en.text).toLowerCase()+'|'+en.match+'|'+en.scope;
      if(seen[k])return; seen[k]=1; out.push(en);
    };
    // 自己填的优先,同一个词词库里再出现就不重复排一遍
    bnWords().forEach(function(w){ push({lib:'',text:w,asin:false,match:match,scope:scope}) });
    bnLibPicked().forEach(push);
    return out;
  }

  /**
   * 这条活动已有的否定索引 —— 已存档的不算,可以重新加回来。
   * 词库一来就是几百上千个词 × 几十条活动,逐个线性找会卡,所以每次算计划先建一次索引。
   */
  function bnNegIndex(cp){
    var have={};
    cp.negatives.forEach(function(nn){
      if(C.normState(curVal(nn.row,S.model.colIdx.state))==='archived')return;
      if(nn.kind==='negTarget'){ have['t|'+nn.adGroupId+'|'+NL.asinCode(nn.text)]=1; return }
      var m=bnMatchSame(nn.matchType,'exact')?'exact':bnMatchSame(nn.matchType,'phrase')?'phrase':'';
      if(!m)return;
      var at=nn.kind==='campNegKw'?'c|':'g|'+nn.adGroupId+'|';
      have['k|'+at+String(nn.text).toLowerCase()+'|'+m]=1;
    });
    return have;
  }

  /** collect=false 只出数字(填汇总用),true 才真的把行建出来 */
  function bnPlan(collect){
    var entries=bnEntries();
    var out=[], n=0, skip=0, camps=0, groups=0, kw=0, asin=0, perGroup=false;
    var add=function(r){ n++; if(collect)out.push(r) };
    entries.forEach(function(en){
      if(en.asin){asin++;perGroup=true}
      else{kw++; if(en.scope!=='campaign')perGroup=true}
    });
    Object.keys(S.bnSel).forEach(function(id){
      if(!S.bnSel[id])return;
      var cp=S.model.byCamp[id]; if(!cp)return;
      camps++; groups+=cp.adGroups.length;
      var have=bnNegIndex(cp);
      entries.forEach(function(en){
        // 否定商品定向后台只收广告组级,活动下每个广告组各写一条
        if(en.asin){
          var code=String(en.text).toUpperCase(), expr=NL.asinExpr(en.text);
          cp.adGroups.forEach(function(g){
            if(have['t|'+g.id+'|'+code]){skip++;return}
            add({kind:'negTarget',campaignId:cp.id,adGroupId:g.id,text:expr,match:'',
              campaignName:cp.name,adGroupName:g.name});
          });
          return;
        }
        var lw=String(en.text).toLowerCase();
        if(en.scope==='campaign'){
          if(have['k|c|'+lw+'|'+en.match]){skip++;return}
          add({kind:'campNegKw',campaignId:cp.id,adGroupId:'',text:en.text,match:en.match,
            campaignName:cp.name,adGroupName:''});
          return;
        }
        cp.adGroups.forEach(function(g){
          if(have['k|g|'+g.id+'|'+lw+'|'+en.match]){skip++;return}
          add({kind:'negKeyword',campaignId:cp.id,adGroupId:g.id,text:en.text,match:en.match,
            campaignName:cp.name,adGroupName:g.name});
        });
      });
    });
    return {rows:out,n:n,skip:skip,words:entries.length,kw:kw,asin:asin,camps:camps,groups:groups,perGroup:perGroup};
  }

  function renderBnList(){
    var list=bnCamps();
    $('#bnList').innerHTML=list.map(function(cp){
      return '<label class="bnitem"><input type="checkbox" data-bnid="'+esc(cp.id)+'"'+(S.bnSel[cp.id]?' checked':'')+'>'+
        '<span class="t"><span class="nm2">'+esc(cp.name)+'</span>'+
        '<span class="s2">'+esc(cp.portfolio||'无组合')+' · '+esc(cp.targetingType||'-')+' · '+
        (cp.state==='paused'?'已暂停':'已启用')+' · '+cp.adGroups.length+' 个广告组</span></span>'+
        '<span class="f2">'+fm(cp.m.spend)+'<br>'+fi(cp.m.clicks)+' 点击</span></label>';
    }).join('')||'<div class="empty">没有符合条件的活动</div>';
    renderBnSum();
  }
  function renderBnSum(){
    var p=bnPlan(false);
    var sel=Object.keys(S.bnSel).filter(function(k){return S.bnSel[k]}).length;
    if(!p.words||!sel){
      $('#bnSum').innerHTML='已选 <b>'+sel+'</b> 个活动 · '+(p.words?('<b>'+p.words+'</b> 个词'):'还没选否定词');
    }else{
      $('#bnSum').innerHTML=p.words+' 个词'+(p.asin?'（含 '+p.asin+' 个 ASIN）':'')+' × '+p.camps+' 个活动'+
        (p.perGroup?'（'+p.groups+' 个广告组）':'')+
        ' → 新增 <b>'+p.n+'</b> 条'+(p.skip?'，跳过 <b>'+p.skip+'</b> 条已存在':'');
    }
    $('#bnGo').disabled=!p.n;
  }

  /** 词条右边那行小字:这个词会怎么否 */
  function bnEntryHow(en){
    if(en.asin)return '否定商品定向 · 广告组级';
    return (en.match==='exact'?'否定精准':'否定词组')+' · '+(en.scope==='campaign'?'活动级':'广告组级');
  }
  /** 词库面板:选类 + D 类联动 + 逐词勾选,整块重画 */
  function renderBnLib(){
    var box=$('#bnLibBody'); if(!box)return;
    $('#bnLibMk').textContent=S.market?S.market+' 站词库':'';
    if(S.libErr){ box.innerHTML='<div class="empty">词库没载入：'+esc(S.libErr)+'</div>'; return; }
    if(!S.lib){ box.innerHTML='<div class="empty">词库载入中…</div>'; return; }

    var cats=NL.libCatalog(S.lib);
    var chips=cats.map(function(cat){
      var n=cat.special==='series'?cat.rows:cat.kw.length+cat.asin.length;
      var usable=!!cat.scope&&n>0;
      var on=usable&&!!S.bnLib.on[cat.id];
      var tip=cat.name+(cat.scope?' · '+cat.scope.scope+' 库 '+cat.rows+' 行':' · 本站没有这一类')+
        (cat.enabled?'':' · 站点已停用');
      return '<span class="chip'+(on?' on':'')+(usable?'':' off')+'"'+(usable?' data-bnlib="'+esc(cat.id)+'"':'')+
        ' title="'+esc(tip)+'">'+esc(cat.id+' '+cat.name)+
        '<span class="chip-sub">'+(cat.scope?(n?n:'空'):'本站没有')+'</span></span>';
    }).join('');

    var picked=cats.filter(function(cat){return S.bnLib.on[cat.id]});
    var how=picked.map(function(cat){
      return cat.id+' '+(cat.match==='exact'?'精准':'词组')+'·'+(cat.level==='campaign'?'活动级':'广告组级');
    }).join(' · ');
    var follow='<label class="bnfollow"><input type="checkbox" id="bnFollow"'+(S.bnLib.follow?' checked':'')+'>'+
      '<span>按词库里设的匹配方式和层级'+(S.bnLib.follow&&how?'<span class="muted"> '+esc(how)+'</span>':'')+'</span></label>';
    var offNote=picked.some(function(cat){return !cat.enabled})
      ? '<div class="bnsub">勾中的类里有「站点已停用」的 —— 生成新广告时不带它，这里是你手动挑的，照样会否。</div>' : '';

    var dcat=cats.filter(function(cat){return cat.special==='series'})[0];
    var series=(dcat&&S.bnLib.on[dcat.id])?bnSeriesHtml(dcat):'';

    var filtering=!!S.bnLib.q;
    var terms=bnLibOn().length
      ? '<div class="bnbar"><input type="text" id="bnLibQ" placeholder="筛这些词…" value="'+esc(S.bnLib.q)+'">'+
        '<button class="btn sm" data-bnpick="all">'+(filtering?'全选筛出的':'全选')+'</button>'+
        '<button class="btn sm" data-bnpick="none">'+(filtering?'去掉筛出的':'全不选')+'</button></div>'+
        '<div class="bnlist bnterms" id="bnTermList"></div>'+
        '<div class="bnsub" id="bnTermCount"></div>'
      : '<div class="empty">上面点一类，这里就出词</div>';

    box.innerHTML='<div class="chips bnlibcats">'+chips+'</div>'+follow+offNote+series+terms;
    if(series)renderBnModels();
    // renderBnTerms 末尾会刷汇总;一个类都没选时没有词条列表,自己刷一次
    if(bnLibOn().length)renderBnTerms(); else renderBnSum();
  }
  /** D 类:先说清楚这些活动在投哪几个墨盒型号,再反推其余该否掉的 */
  function bnSeriesHtml(dcat){
    var plan=NL.seriesPlan(S.lib,S.bnLib.models,S.bnLib.only);
    var only=[['both','墨盒 + 打印机'],['models','只否墨盒'],['printers','只否打印机']].map(function(x){
      return '<button class="btn sm'+(S.bnLib.only===x[0]?' pri':'')+'" data-bnonly="'+x[0]+'">'+x[1]+'</button>';
    }).join('');
    return '<div class="bnseries">'+
      '<div class="bnsub">这些活动在投的墨盒型号 —— 留下它们，'+esc(dcat.id)+' 类里其余的墨盒和打印机型号全否掉，'+
        '和开系列广告时一个口径。所以只在「都在投同一批型号」的活动上一起用。</div>'+
      '<div class="bnbar"><input type="text" id="bnModelQ" placeholder="搜墨盒型号…（逗号分开一次搜多个）" value="'+esc(S.bnLib.mq)+'">'+
        (S.bnLib.models.length?'<button class="btn sm" data-bnmodel-clear="1">清空 '+S.bnLib.models.length+' 个</button>':'')+'</div>'+
      '<div class="chips bnmodels" id="bnModels"></div>'+
      '<div class="bnbar">'+only+'</div>'+
      (plan
        ? '<div class="bnsub">投放 '+S.bnLib.models.length+' 个型号 → 否掉 '+plan.series.models.length+' 个墨盒 / '+
          plan.series.printers.length+' 个打印机'+
          (plan.series.unknown.length?'。这些型号库里没有：'+esc(plan.series.unknown.join('、')):'')+'</div>'
        : '<div class="bnsub">先选在投的墨盒型号，这里才算得出该否掉哪些。</div>')+
      '</div>';
  }
  /** D 类型号组,只重画列表本身,搜索框不动 */
  function renderBnModels(){
    var box=$('#bnModels'); if(!box)return;
    var groups=NL.seriesModelGroups(S.lib);
    var picked={}; S.bnLib.models.forEach(function(m){picked[String(m).toLowerCase()]=1});
    // 搜索框逗号 / 换行分开的是「或」,一次搜多个型号
    var q=S.bnLib.mq.toLowerCase().split(/[,，、;；\n]+/).map(function(x){return x.trim()}).filter(Boolean);
    var shown=groups.filter(function(g){
      if(!q.length)return true;
      return q.some(function(t){return g.label.toLowerCase().indexOf(t)>=0});
    });
    box.innerHTML=shown.slice(0,BN_MODEL_MAX).map(function(g){
      var on=g.models.some(function(m){return picked[m.toLowerCase()]});
      return '<span class="chip'+(on?' on':'')+'" data-bnmodel="'+esc(g.label)+'" title="'+g.count+' 台打印机">'+
        esc(g.label)+'<span class="chip-sub">'+g.count+'</span></span>';
    }).join('')+
      (shown.length>BN_MODEL_MAX?'<span class="muted">…还有 '+(shown.length-BN_MODEL_MAX)+' 个，搜一下缩小范围</span>':'')+
      (shown.length?'':'<span class="muted">'+(groups.length?'没有匹配的型号':'这个区域的 D 类还没有数据')+'</span>');
  }
  /** 词条列表,只重画列表本身,筛选框不动 */
  function renderBnTerms(){
    var box=$('#bnTermList'); if(!box)return;
    var all=bnLibAll();
    var q=S.bnLib.q.toLowerCase();
    var shown=q?all.filter(function(en){return String(en.text).toLowerCase().indexOf(q)>=0}):all;
    box.innerHTML=shown.slice(0,BN_TERM_MAX).map(function(en){
      var k=NL.entryKey(en), off=!!S.bnLib.off[k];
      return '<label class="bnterm'+(off?' off':'')+'"><input type="checkbox" data-bnt="'+esc(k)+'"'+(off?'':' checked')+'>'+
        '<span class="t3 mono">'+esc(en.text)+'</span><span class="tag">'+esc(en.lib)+'</span>'+
        '<span class="s3">'+esc(bnEntryHow(en))+'</span></label>';
    }).join('')||'<div class="empty">'+(all.length?'没有匹配的词':'这几类还没出词')+'</div>';
    renderBnTermCount(all.length,shown.length);
  }
  function renderBnTermCount(total,shown){
    var cnt=$('#bnTermCount');
    if(cnt){
      var all=total===undefined?bnLibAll().length:total;
      cnt.textContent='词库出 '+all+' 个词，勾中 '+bnLibPicked().length+' 个'+
        (shown>BN_TERM_MAX?'（列表只显示前 '+BN_TERM_MAX+' 个，勾选和统计算的是全部）':'');
    }
    renderBnSum();
  }
  function bnSetOff(list,off){
    list.forEach(function(en){
      var k=NL.entryKey(en);
      if(off)S.bnLib.off[k]=1; else delete S.bnLib.off[k];
    });
  }

  function openBneg(){
    if(!S.model){toast('先载入批量表');return}
    var set={};S.model.campaigns.forEach(function(c2){if(c2.portfolio)set[c2.portfolio]=1});
    $('#bnPf').innerHTML='<option value="">全部广告组合</option>'+Object.keys(set).sort().map(function(x){
      return '<option'+(S.bnPf===x?' selected':'')+'>'+esc(x)+'</option>'}).join('');
    $('#bnSrch').value=S.bnQ;
    renderBnLib();
    renderBnList();
    $('#maskBneg').classList.add('on');
  }
  $('#btnBneg').onclick=openBneg;
  $('#maskBneg').addEventListener('click',function(e){
    var b=e.target.closest('[data-bnsel]');
    if(b){
      var op=b.dataset.bnsel;
      if(op==='none')S.bnSel={};
      else{
        var src=op==='rail'?filteredCamps():bnCamps();
        src.forEach(function(cp){
          if(op==='spend'&&cp.m.spend<=0)return;
          if(op==='enabled'&&cp.state!=='enabled')return;
          S.bnSel[cp.id]=1;
        });
      }
      renderBnList();
      return;
    }
    var cat=e.target.closest('[data-bnlib]');
    if(cat){
      var id=cat.dataset.bnlib;
      if(S.bnLib.on[id])delete S.bnLib.on[id]; else S.bnLib.on[id]=1;
      renderBnLib();
      return;
    }
    var only=e.target.closest('[data-bnonly]');
    if(only){ S.bnLib.only=only.dataset.bnonly; renderBnLib(); return; }
    var mg=e.target.closest('[data-bnmodel]');
    if(mg){
      var label=mg.dataset.bnmodel;
      var group=NL.seriesModelGroups(S.lib).filter(function(g){return g.label===label})[0];
      if(group){
        var has={};S.bnLib.models.forEach(function(m){has[String(m).toLowerCase()]=1});
        var on=group.models.some(function(m){return has[m.toLowerCase()]});
        var drop={};group.models.forEach(function(m){drop[m.toLowerCase()]=1});
        S.bnLib.models=on
          ? S.bnLib.models.filter(function(m){return !drop[String(m).toLowerCase()]})
          : S.bnLib.models.concat(group.models.filter(function(m){return !has[m.toLowerCase()]}));
      }
      renderBnLib();
      return;
    }
    if(e.target.closest('[data-bnmodel-clear]')){
      S.bnLib.models=[]; renderBnLib(); return;
    }
    var bt=e.target.closest('[data-bnpick]');
    if(bt){
      var q=S.bnLib.q.toLowerCase();
      var list=bnLibAll().filter(function(en){return !q||String(en.text).toLowerCase().indexOf(q)>=0});
      bnSetOff(list,bt.dataset.bnpick==='none');
      renderBnTerms();
      return;
    }
  });
  $('#maskBneg').addEventListener('change',function(e){
    var el=e.target;
    if(el.dataset.bnid!==undefined){ S.bnSel[el.dataset.bnid]=el.checked; renderBnSum(); return; }
    if(el.dataset.bnt!==undefined){
      if(el.checked)delete S.bnLib.off[el.dataset.bnt]; else S.bnLib.off[el.dataset.bnt]=1;
      var row=el.closest('.bnterm'); if(row)row.classList.toggle('off',!el.checked);
      renderBnTermCount();
      return;
    }
    if(el.id==='bnFollow'){ S.bnLib.follow=el.checked; renderBnLib(); return; }
    if(el.id==='bnPf'){ S.bnPf=el.value; renderBnList(); return; }
    if(el.id==='bnMatch'||el.id==='bnScope'){
      // 不跟词库设置走时,词库来的词也跟着这两项变
      if(!S.bnLib.follow&&bnLibOn().length)renderBnTerms(); else renderBnSum();
      return;
    }
  });
  $('#maskBneg').addEventListener('input',function(e){
    if(e.target.id==='bnSrch'){ S.bnQ=e.target.value.trim(); renderBnList(); return; }
    if(e.target.id==='bnLibQ'){
      var was=!!S.bnLib.q;
      S.bnLib.q=e.target.value.trim();
      renderBnTerms();
      // 有没有在筛,决定上面两个按钮叫什么;输入框本身不重画,不然焦点会跑
      if(was!==!!S.bnLib.q){
        var btns=$$('#bnLibBody [data-bnpick]');
        if(btns[0])btns[0].textContent=S.bnLib.q?'全选筛出的':'全选';
        if(btns[1])btns[1].textContent=S.bnLib.q?'去掉筛出的':'全不选';
      }
      return;
    }
    if(e.target.id==='bnModelQ'){ S.bnLib.mq=e.target.value.trim(); renderBnModels(); return; }
    if(e.target.id==='bnText'){
      clearTimeout(S._bnT);
      S._bnT=setTimeout(renderBnSum,180);
    }
  });
  $('#bnGo').onclick=function(){
    var p=bnPlan(true);
    if(!p.rows.length)return;
    if(p.rows.length>1500&&!confirm('这次会新增 '+p.rows.length+' 条否定，数量不小，确定继续？'))return;
    var added=0;
    p.rows.forEach(function(r){ if(S.changes.addNegative(r))added++ });
    $('#maskBneg').classList.remove('on');
    renderFoot(); renderRail(); renderDetail();
    toast('已加入 '+added+' 条否定'+(p.skip?'，跳过 '+p.skip+' 条已存在':'')+(p.rows.length-added?'，'+(p.rows.length-added)+' 条此前已加过':''));
  };

  /** 站点词库由外面(React 页面)载好再送进来,换站点会再送一次 */
  function setLibrary(market,raw,err){
    S.market=market||'';
    S.lib=raw?NL.normLibData(raw):null;
    S.libErr=err||'';
    S.bnLib.on={}; S.bnLib.off={}; S.bnLib.models=[]; S.bnLib.q=''; S.bnLib.mq='';
    S.bnLib.ver++; S.bnLib._sig=''; S.bnLib._all=[];
    if($('#maskBneg').classList.contains('on'))renderBnLib();
  }

  /* ---------- 底栏 / 变更清单 ---------- */
  function renderFoot(){
    var n=S.changes.count();
    var el=$('#chgCount');
    el.textContent=n+' 处改动 · '+S.changes.rowCount()+' 行';
    el.classList.toggle('zero',n===0);
  }
  function renderChanges(){
    var list=C.changeList(S.model,S.changes);
    $('#chgSum').textContent=list.length+' 处';
    if(!list.length){ $('#chgBody').innerHTML='<div class="empty">还没有任何改动</div>'; return; }
    $('#chgBody').innerHTML='<table class="tbl"><thead><tr><th>活动</th><th>层级</th><th>对象</th><th>字段</th><th class="r">原值</th><th class="r">新值</th><th></th></tr></thead><tbody>'+
      list.map(function(x){
        return '<tr><td style="max-width:200px;word-break:break-all">'+esc(x.campaign)+'<div class="muted" style="font-size:10px">'+esc(x.adGroup)+'</div></td>'+
          '<td><span class="tag">'+esc(x.entity)+'</span></td><td style="max-width:180px;word-break:break-all">'+esc(x.object)+'</td>'+
          '<td>'+esc(x.field)+'</td><td class="num muted">'+esc(x.from)+'</td><td class="num" style="color:var(--cy);font-weight:700">'+esc(x.to)+'</td>'+
          '<td><button class="btn sm" data-undo="'+(x.type==='create'?'c'+x.createId:'e'+x.rowIndex+':'+x.col)+'">撤销</button></td></tr>';
      }).join('')+'</tbody></table>';
  }
  $('#chgBody').addEventListener('click',function(e){
    var b=e.target.closest('[data-undo]'); if(!b)return;
    var k=b.dataset.undo;
    if(k[0]==='c')S.changes.removeCreate(+k.slice(1));
    else{ var p=k.slice(1).split(':'); S.changes.clearCell(+p[0],+p[1]); }
    renderChanges(); renderFoot(); renderRail(); renderDetail();
  });
  $('#btnChanges').onclick=function(){ renderChanges(); $('#maskChg').classList.add('on'); };
  $('#chgUndoAll').onclick=$('#btnUndoAll').onclick=function(){
    if(!S.changes.count())return;
    if(!confirm('撤销全部 '+S.changes.count()+' 处改动？'))return;
    S.changes=new C.ChangeSet(); renderFoot(); renderRail(); renderDetail(); renderChanges();
  };
  $$('[data-close]').forEach(function(b){b.onclick=function(){b.closest('.mask').classList.remove('on')}});
  $$('.mask').forEach(function(m){m.onclick=function(e){if(e.target===m)m.classList.remove('on')}});

  /* ---------- 设置 ---------- */
  $('#btnSet').onclick=function(){
    $('#s_acos').value=(S.cfg.targetAcos*100).toFixed(0);
    $('#s_zspend').value=S.cfg.zeroOrderSpend; $('#s_zclick').value=S.cfg.zeroOrderClicks;
    $('#s_ctr').value=(S.cfg.lowCtr*100).toFixed(2); $('#s_cvr').value=(S.cfg.lowCvr*100).toFixed(0);
    $('#s_skucvr').value=(S.cfg.skuCvrMin*100).toFixed(0); $('#s_skuacos').value=(S.cfg.skuAcosMax*100).toFixed(1);
    $('#s_skudead').value=S.cfg.skuDeadClicks;
    $('#s_vocab').value=S.vocab; $('#s_scope').value=S.scope; $('#s_cur').value=S.cur;
    $('#maskSet').classList.add('on');
  };
  $('#setSave').onclick=function(){
    S.cfg.targetAcos=(parseFloat($('#s_acos').value)||25)/100;
    S.cfg.zeroOrderSpend=parseFloat($('#s_zspend').value)||0.8;
    S.cfg.zeroOrderClicks=parseFloat($('#s_zclick').value)||8;
    S.cfg.lowCtr=(parseFloat($('#s_ctr').value)||0.15)/100;
    S.cfg.lowCvr=(parseFloat($('#s_cvr').value)||10)/100;
    S.cfg.skuCvrMin=(parseFloat($('#s_skucvr').value)||20)/100;
    S.cfg.skuAcosMax=(parseFloat($('#s_skuacos').value)||6.5)/100;
    S.cfg.skuDeadClicks=parseFloat($('#s_skudead').value)||5;
    S.vocab=$('#s_vocab').value; S.scope=$('#s_scope').value; S.cur=$('#s_cur').value||'€';
    $('#maskSet').classList.remove('on'); renderAll(); toast('规则已更新');
  };

  /* ---------- 导出 ---------- */
  function exportName(ext){
    var p=$('#periodA').value.trim().replace(/[/\\:*?"<>|]/g,'-');
    var d=new Date(), ts=d.getFullYear()+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0')+'-'+String(d.getHours()).padStart(2,'0')+String(d.getMinutes()).padStart(2,'0');
    return '批量优化'+(p?'_'+p:'')+'_'+ts+'.'+ext;
  }
  function download(blob,name){
    var a=document.createElement('a'), url=URL.createObjectURL(blob);
    a.href=url; a.download=name; document.body.appendChild(a); a.click();
    setTimeout(function(){URL.revokeObjectURL(url);a.remove()},400);
  }
  $('#btnExport').onclick=$('#btnExport2').onclick=$('#chgExport').onclick=function(){
    if(!S.model){toast('先载入批量表');return;}
    $('#maskChg').classList.remove('on');
    if(!S.changes.count()){ toast('还没有任何改动'); return; }
    var issues=C.validate(S.model,S.changes);
    var list=C.changeList(S.model,S.changes);
    var byEntity={};
    list.forEach(function(x){ byEntity[x.entity]=(byEntity[x.entity]||0)+1 });
    var drop=(S.model.sheetNames||[]).filter(function(n){
      return n!==S.model.sheetName && n!=='广告组合' && n!=='Portfolios';
    });
    $('#expBody').innerHTML=
      '<p style="margin:0 0 10px">将导出 <b>'+S.changes.rowCount()+'</b> 行、<b>'+S.changes.count()+'</b> 处改动。</p>'+
      '<table class="tbl"><tbody>'+Object.keys(byEntity).map(function(k){
        return '<tr><td>'+esc(k)+'</td><td class="num">'+byEntity[k]+' 处</td></tr>'}).join('')+'</tbody></table>'+
      (issues.length?'<div class="diag" style="margin:12px 0 0"><h4>导出前检查</h4><ul>'+issues.map(function(i){
        return '<li><span class="flagchip '+(i.level==='error'?'bad':'warn')+'">'+(i.level==='error'?'必须修正':'留意')+'</span>'+esc(i.text)+'</li>'}).join('')+'</ul></div>'
       :'<div class="diag" style="border-left-color:var(--gd);margin:12px 0 0"><h4>导出前检查</h4><div style="font-size:12px">竞价、预算、溢价数值都在允许范围内。</div></div>')+
      (drop.length?'<div class="diag" style="margin:12px 0 0"><h4>会摘掉的工作表</h4><ul>'+
        drop.map(function(n){return '<li>'+esc(n)+'</li>'}).join('')+
        '</ul><div style="font-size:11px;margin-top:6px">这些表的前三列不是「产品 / 实体层级 / 操作」，'+
        '后台只认批量表工作表，原样传回去会判「标头无效」把整份文件退回。导出时自动去掉，不影响你在工作台里看这些数据。</div></div>':'')+
      '<p class="muted" style="font-size:11px;margin:12px 0 0">导出的文件保留原表的批量表工作表结构，只有改动行的「操作」列被填成 '+
        ((C.VOCAB[S.vocab||S.model.lang]||C.VOCAB.zh).op.update)+'，其余行亚马逊会自动忽略。回后台走「上传批量文件」即可。</p>';
    $('#expGo').disabled=issues.some(function(i){return i.level==='error'});
    $('#maskExp').classList.add('on');
  };
  $('#expGo').onclick=function(){
    try{
      var wb=XLSX.read(S.raw,{type:'array'});
      var rows=C.buildExportRows(S.model,S.changes,{vocab:S.vocab});
      var aoa;
      if(S.scope==='all'){
        var idx=Object.keys(S.changes.edits).map(Number);
        var full=S.model.rows.map(function(r){return r.d.slice()});
        idx.forEach(function(ri){
          var e=S.changes.edits[ri];
          Object.keys(e).forEach(function(col){ full[ri][col]=e[col].to });
          if(S.model.colIdx.operation>=0) full[ri][S.model.colIdx.operation]=(C.VOCAB[S.vocab||S.model.lang]||C.VOCAB.zh).op.update;
        });
        var creates=rows.slice(idx.length);
        aoa=[S.model.header].concat(full).concat(creates);
      }else{
        aoa=[S.model.header].concat(rows);
      }
      wb.Sheets[S.model.sheetName]=XLSX.utils.aoa_to_sheet(aoa);
      // 导出的批量表只需要广告组合与商品推广活动两个工作表
      var dropped=C.retainExportSheets(wb,S.model.sheetName);
      var out=XLSX.write(wb,{type:'array',bookType:'xlsx'});
      download(new Blob([out],{type:'application/octet-stream'}),exportName('xlsx'));
      $('#maskExp').classList.remove('on');
      toast('已生成批量表，回后台上传即可'+(dropped.length?'（已摘掉 '+dropped.length+' 个后台不收的工作表）':''));
    }catch(err){ alert('导出失败：'+err.message); }
  };
  $('#btnCsv').onclick=$('#chgCsv').onclick=function(){
    var list=C.changeList(S.model,S.changes);
    if(!list.length){toast('还没有任何改动');return;}
    var head=['广告活动','广告组','层级','对象','字段','原值','新值'];
    var csv=[head].concat(list.map(function(x){return [x.campaign,x.adGroup,x.entity,x.object,x.field,x.from,x.to]}))
      .map(function(r){return r.map(function(v){return '"'+String(v===null||v===undefined?'':v).replace(/"/g,'""')+'"'}).join(',')}).join('\r\n');
    download(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}),exportName('csv'));
  };

  /* ---------- 进度存档 ---------- */
  $('#btnSaveProg').onclick=function(){
    if(!S.model){toast('先载入批量表');return;}
    var data={file:S.fileName,period:$('#periodA').value,cfg:S.cfg,cur:S.cur,vocab:S.vocab,scope:S.scope,
      edits:S.changes.edits,creates:S.changes.creates,seq:S.changes.seq,ts:new Date().toISOString()};
    download(new Blob([JSON.stringify(data)],{type:'application/json'}),exportName('json').replace('批量优化','优化进度'));
  };
  $('#btnLoadProg').onclick=function(){ if(!S.model){toast('先载入同一份批量表');return;} $('#fileP').click(); };
  $('#fileP').onchange=function(e){ if(e.target.files[0])loadProgress(e.target.files[0]); e.target.value=''; };
  function loadProgress(file){
    if(!S.model){toast('请先载入对应的批量表，再载入进度');return;}
    var fr=new FileReader();
    fr.onload=function(ev){
      try{
        var d=JSON.parse(ev.target.result);
        if(d.file&&d.file!==S.fileName&&!confirm('进度文件对应的是「'+d.file+'」，当前载入的是「'+S.fileName+'」。行号可能对不上，继续？'))return;
        S.changes=new C.ChangeSet(); S.changes.edits=d.edits||{}; S.changes.setCreates(d.creates); S.changes.seq=d.seq||0;
        if(d.cfg)S.cfg=Object.assign({},C.DEFAULT_CFG,d.cfg);
        if(d.cur)S.cur=d.cur; if(d.period)$('#periodA').value=d.period;
        if(d.vocab!==undefined)S.vocab=d.vocab; if(d.scope)S.scope=d.scope;
        renderAll(); toast('进度已恢复：'+S.changes.count()+' 处改动');
      }catch(err){ alert('进度文件读取失败：'+err.message); }
    };
    fr.readAsText(file);
  }

  /* ================= 数据分析面板 ================= */
  function anTh(key,label,right){
    var s=S.an.sort[S.an.tab]||{},on=s.k===key;
    return '<th class="'+(right?'r ':'')+(on?'on':'')+'" data-ansort="'+key+'">'+label+'<span class="ar">'+(on&&s.d>0?'▲':'▼')+'</span></th>';
  }
  function anSortList(list,get){
    var s=S.an.sort[S.an.tab];
    if(!s||!s.k)return list;
    return list.slice().sort(function(a,b){
      var x=get(a,s.k),y=get(b,s.k);
      if(typeof x==='string'||typeof y==='string')return String(x).localeCompare(String(y))*s.d;
      return ((x||0)-(y||0))*s.d;
    });
  }
  function anMetricGet(o,k){
    if(k==='acos')return o.m.sales>0?o.m.acos:(o.m.spend>0?99:-1);
    if(o.m[k]!==undefined)return o.m[k];
    return o[k];
  }
  function anPfOptions(){
    var set={};S.model.campaigns.forEach(function(c2){if(c2.portfolio)set[c2.portfolio]=1});
    return '<select id="anPf"><option value="">全部广告组合</option>'+Object.keys(set).sort().map(function(x){
      return '<option'+(S.an.pf===x?' selected':'')+'>'+esc(x)+'</option>'}).join('')+'</select>';
  }
  function anCampOk(cp){ return !S.an.pf||cp.portfolio===S.an.pf }
  function anSkuOptions(){
    var idx=skuIndex(),skus=Object.keys(idx.s2g).filter(Boolean).sort();
    return '<select id="anSku"><option value="">不限 SKU</option>'+skus.map(function(k){
      var n=0;Object.keys(idx.s2g[k]).forEach(function(g){n+=(idx.stByGroup[g]||[]).length});
      return '<option value="'+esc(k)+'"'+(S.an.sku===k?' selected':'')+'>'+esc(k)+'（'+n+' 条词）</option>';
    }).join('')+'</select>';
  }
  function mCells(m){
    return '<td class="num">'+fi(m.imp)+'</td><td class="num">'+fi(m.clicks)+'</td><td class="num">'+fp(m.ctr,2)+'</td>'+
      '<td class="num">'+fm(m.spend)+'</td><td class="num">'+fi(m.orders)+'</td><td class="num">'+fp(m.cvr,1)+'</td>'+
      '<td class="num">'+fm(m.sales)+'</td><td class="num acos-cell">'+facos(m)+'</td><td class="num">'+S.cur+m.cpc.toFixed(3)+'</td>';
  }
  function mHeads(){
    return anTh('imp','曝光',1)+anTh('clicks','点击',1)+'<th class="r">点击率</th>'+anTh('spend','花费',1)+
      anTh('orders','订单',1)+anTh('cvr','转化率',1)+'<th class="r">销售额</th>'+anTh('acos','ACOS',1)+'<th class="r">CPC</th>';
  }
  function anExpKey(k){ return S.an.tab+'|'+k }
  function isExp(k){ return !!S.an.exp[anExpKey(k)] }

  /* ---------- 广告组 ↔ SKU ↔ 搜索词 索引 ---------- */
  function skuIndex(){
    if(!S.model._skuIdx){
      var g2s={},s2g={},stByGroup={};
      S.model.campaigns.forEach(function(cp){
        cp.ads.forEach(function(a){
          (g2s[a.adGroupId]=g2s[a.adGroupId]||{})[a.sku]=1;
          (s2g[a.sku]=s2g[a.sku]||{})[a.adGroupId]=1;
        });
      });
      S.model.searchTerms.forEach(function(s){
        (stByGroup[s.adGroupId]=stByGroup[s.adGroupId]||[]).push(s);
      });
      S.model._skuIdx={g2s:g2s,s2g:s2g,stByGroup:stByGroup};
    }
    return S.model._skuIdx;
  }
  // 该广告组里的 SKU 是否全部属于这一行（独占 → 搜索词可以算在它头上）
  function groupExclusive(gid,skuSet){
    var g=skuIndex().g2s[gid]||{},ks=Object.keys(g);
    return ks.length>0&&ks.every(function(x){return skuSet[x]});
  }
  function skuTerms(o,exclOnly){
    var idx=skuIndex(),gids={},out=[];
    o.items.forEach(function(x){gids[x.ad.adGroupId]=1});
    Object.keys(gids).forEach(function(g){
      var ex=groupExclusive(g,o.skuSet);
      if(exclOnly&&!ex)return;
      (idx.stByGroup[g]||[]).forEach(function(s){out.push({s:s,ex:ex,gid:g,nSku:Object.keys(idx.g2s[g]||{}).length})});
    });
    return out;
  }
  function aggSkuTerms(rows){
    var map={};
    rows.forEach(function(r){
      var k=String(r.s.term).toLowerCase();
      var e=map[k]||(map[k]={term:r.s.term,items:[],camps:{},groups:{},ex:true,maxSku:1});
      e.items.push(r.s);e.camps[r.s.campaignId]=1;e.groups[r.gid]=1;
      if(!r.ex)e.ex=false;
      if(r.nSku>e.maxSku)e.maxSku=r.nSku;
    });
    return Object.keys(map).map(function(k){
      var e=map[k];e.m=C.sumMetrics(e.items.map(function(x){return x.m}));e.nc=Object.keys(e.camps).length;return e;
    }).sort(function(a,b){return b.m.spend-a.m.spend||b.m.clicks-a.m.clicks});
  }

  /* ---------- 面板一：SKU / ASIN 矩阵 ---------- */
  function anSkuData(){
    var byAsin=S.an.byAsin,map={};
    S.model.campaigns.forEach(function(cp){
      if(!anCampOk(cp))return;
      cp.ads.forEach(function(ad){
        var key=byAsin?(ad.asin||'（无 ASIN）'):(ad.sku||'（无 SKU）');
        var o=map[key]||(map[key]={key:key,sku:ad.sku,asin:ad.asin,items:[],camps:{}});
        o.items.push({cp:cp,ad:ad});o.camps[cp.id]=1;
      });
    });
    var list=Object.keys(map).map(function(k){
      var o=map[k];o.m=C.sumMetrics(o.items.map(function(x){return x.ad.m}));o.nc=Object.keys(o.camps).length;
      o.skuSet={};o.items.forEach(function(x){o.skuSet[x.ad.sku]=1});
      o.stAll=skuTerms(o,false).length;o.stEx=skuTerms(o,true).length;
      return o;
    });
    var base=C.sumMetrics(list.map(function(o){return o.m}));
    list.forEach(function(o){
      o.pClick=base.clicks?o.m.clicks/base.clicks:0;
      o.pOrder=base.orders?o.m.orders/base.orders:0;
      o.pSpend=base.spend?o.m.spend/base.spend:0;
    });
    return {list:list,base:base};
  }
  function skuMark(m){
    if(m.clicks>=S.cfg.skuDeadClicks&&m.orders===0)return 'blue';
    if(m.orders>0&&m.cvr<S.cfg.skuCvrMin&&m.acos>=S.cfg.skuAcosMax)return 'red';
    return '';
  }
  function anSku(){
    var data=anSkuData(),q=S.an.q.toLowerCase();
    var list=data.list.filter(function(o){
      if(S.an.minClicks&&o.m.clicks<S.an.minClicks)return false;
      if(S.an.mark==='red'&&skuMark(o.m)!=='red')return false;
      if(S.an.mark==='blue'&&skuMark(o.m)!=='blue')return false;
      if(q&&(String(o.sku)+' '+String(o.asin)).toLowerCase().indexOf(q)<0)return false;
      return true;
    });
    list=anSortList(list,function(o,k){
      if(k==='key')return String(o.key);
      if(k==='nc')return o.nc;
      if(k==='stAll')return o.stAll;
      if(k==='pClick')return o.pClick;
      if(k==='pOrder')return o.pOrder;
      return anMetricGet(o,k);
    });
    var sum=C.sumMetrics(list.map(function(o){return o.m}));
    var bar='<div class="anbar">'+
      '<div class="seg"><span class="sgb'+(S.an.byAsin?'':' on')+'" data-anby="sku">按 SKU</span><span class="sgb'+(S.an.byAsin?' on':'')+'" data-anby="asin">按 ASIN</span></div>'+
      anPfOptions()+
      '<input type="text" id="anQ" placeholder="搜 SKU / ASIN" value="'+esc(S.an.q)+'">'+
      '<label>最小点击 <input type="number" id="anMin" value="'+(S.an.minClicks||0)+'" min="0" style="width:64px"></label>'+
      '<div class="seg"><span class="sgb'+(!S.an.mark?' on':'')+'" data-anmark="">全部</span>'+
        '<span class="sgb mk-red'+(S.an.mark==='red'?' on':'')+'" data-anmark="red">低转化高 ACOS</span>'+
        '<span class="sgb mk-blue'+(S.an.mark==='blue'?' on':'')+'" data-anmark="blue">点击无转化</span></div>'+
      '<div style="flex:1"></div><button class="btn sm" id="anCsv">导出本面板 CSV</button></div>'+
      '<div class="anhint">红色＝转化率低于 '+fp(S.cfg.skuCvrMin,0)+' 且 ACOS ≥ '+fp(S.cfg.skuAcosMax,1)+'；蓝色＝点击 ≥ '+S.cfg.skuDeadClicks+' 次零转化。阈值在「规则设置」里改。点任意一行展开，可以切「在各活动的表现」和「跑出的搜索词」。</div>';
    if(!list.length)return bar+'<div class="empty">没有符合条件的 SKU</div>';
    return bar+'<table class="tbl antbl"><thead><tr>'+
      anTh('key',S.an.byAsin?'ASIN':'广告 SKU')+(S.an.byAsin?'':'<th>ASIN</th>')+anTh('nc','活动数',1)+
      anTh('stAll','搜索词 独占/全部',1)+anTh('pClick','点击占比',1)+anTh('pOrder','订单占比',1)+mHeads()+'</tr></thead><tbody>'+
      list.map(function(o){
        var mk=skuMark(o.m);
        return '<tr class="anrow'+(mk?' mk-'+mk:'')+(isExp(o.key)?' expd':'')+'" data-anexp="'+esc(o.key)+'">'+
          '<td class="anname">'+esc(o.key)+'</td>'+(S.an.byAsin?'':'<td class="muted mono" style="font-size:12px">'+esc(o.asin)+'</td>')+
          '<td class="num">'+o.nc+'</td>'+
          '<td class="num">'+(o.stAll?('<b'+(o.stEx?' style="color:var(--gd)"':'')+'>'+o.stEx+'</b> / '+o.stAll):'<span class="muted">—</span>')+'</td>'+
          '<td class="num">'+fp(o.pClick,2)+'</td><td class="num">'+fp(o.pOrder,2)+'</td>'+
          mCells(o.m)+'</tr>'+(isExp(o.key)?anSkuSub(o):'');
      }).join('')+
      '</tbody><tfoot><tr><td>合计 '+list.length+' 项</td>'+(S.an.byAsin?'':'<td></td>')+'<td></td><td></td><td class="num">100%</td><td class="num">100%</td>'+mCells(sum)+'</tr></tfoot></table>';
  }
  function anSkuSub(o){
    var mode=S.an.skuSub[o.key]||'camp';
    var seg='<span class="subseg"><span class="sgb'+(mode==='camp'?' on':'')+'" data-skusub="camp|'+esc(o.key)+'">在各活动的表现 '+o.nc+'</span>'+
      '<span class="sgb'+(mode==='st'?' on':'')+'" data-skusub="st|'+esc(o.key)+'">跑出的搜索词 '+o.stAll+'</span></span>';
    return '<tr class="subrow"><td colspan="'+(S.an.byAsin?14:15)+'" class="subcell"><div class="subwrap">'+
      (mode==='st'?anSkuStBody(o,seg):anSkuCampBody(o,seg))+'</div></td></tr>';
  }
  function anSkuStBody(o,seg){
    if(!S.model.searchTerms.length)
      return '<div class="subcap"><b>'+esc(o.key)+'</b>'+seg+'</div><div class="subnote">还没有搜索词数据，点右上角「载入搜索词报告」或重新下载带搜索词报告的批量表。</div>';
    var only=S.an.skuExcl[o.key];
    if(only===undefined)only=o.stEx>0;
    var rows=skuTerms(o,only),list=aggSkuTerms(rows);
    S.an._skuStList=list;
    var tot=C.sumMetrics(list.map(function(x){return x.m}));
    var toggle='<span class="subseg"><span class="sgb'+(only?' on':'')+'" data-skuexcl="1|'+esc(o.key)+'">仅独占广告组 '+o.stEx+'</span>'+
      '<span class="sgb'+(only?'':' on')+'" data-skuexcl="0|'+esc(o.key)+'">全部所在广告组 '+o.stAll+'</span></span>';
    var head='<div class="subcap"><b>'+esc(o.key)+' 跑出的顾客搜索词</b>'+seg+toggle+'</div>'+
      '<div class="subnote">亚马逊的搜索词报告只到广告组这一层，本身不带 SKU。这里的词是按「这个 SKU 所在的广告组」关联出来的：标<span class="own ex">独占</span>的广告组里只有它，数据可以算在它头上；标<span class="own sh">共享</span>的广告组还有别的 SKU 在跑，那一行的数据是整个广告组的，拆不到单个 SKU。</div>';
    if(!list.length)return head+'<div class="empty" style="padding:26px">'+(only?'这个 SKU 没有独占的广告组，切到「全部所在广告组」看看':'没有关联到搜索词')+'</div>';
    return head+'<table class="sub"><thead><tr><th>顾客搜索词</th><th>归属</th><th class="r">活动数</th>'+
      '<th class="r">曝光</th><th class="r">点击</th><th class="r">点击率</th><th class="r">花费</th><th class="r">订单</th>'+
      '<th class="r">转化率</th><th class="r">销售额</th><th class="r">ACOS</th><th>否定</th></tr></thead><tbody>'+
      list.map(function(e,i){
        return '<tr><td style="max-width:260px;word-break:break-all">'+esc(e.term)+'</td>'+
          '<td>'+(e.ex?'<span class="own ex">独占</span>':'<span class="own sh">与 '+e.maxSku+' 个 SKU 共享</span>')+'</td>'+
          '<td class="num">'+e.nc+'</td>'+
          '<td class="num">'+fi(e.m.imp)+'</td><td class="num">'+fi(e.m.clicks)+'</td><td class="num">'+fp(e.m.ctr,2)+'</td>'+
          '<td class="num">'+fm(e.m.spend)+'</td><td class="num">'+fi(e.m.orders)+'</td><td class="num">'+fp(e.m.cvr,1)+'</td>'+
          '<td class="num">'+fm(e.m.sales)+'</td><td class="num">'+facos(e.m)+'</td>'+
          '<td>'+(e.items.every(function(x){return alreadyNegated(x.campaignId,x.term)})
            ?'<span class="flagchip good">已加入否定</span>'
            :'<button class="btn sm" data-skuneg="'+i+'" data-match="phrase">词组</button> '+
             '<button class="btn sm" data-skuneg="'+i+'" data-match="exact">精准</button>')+'</td></tr>';
      }).join('')+'</tbody><tfoot><tr><td>合计 '+list.length+' 个词</td><td></td><td></td>'+
      '<td class="num">'+fi(tot.imp)+'</td><td class="num">'+fi(tot.clicks)+'</td><td class="num">'+fp(tot.ctr,2)+'</td>'+
      '<td class="num">'+fm(tot.spend)+'</td><td class="num">'+fi(tot.orders)+'</td><td class="num">'+fp(tot.cvr,1)+'</td>'+
      '<td class="num">'+fm(tot.sales)+'</td><td class="num">'+facos(tot)+'</td><td></td></tr></tfoot></table>';
  }
  function anSkuCampBody(o,seg){
    var c=S.model.colIdx;
    var items=o.items.slice().sort(function(a,b){return b.ad.m.spend-a.ad.m.spend||b.ad.m.imp-a.ad.m.imp});
    S.an._skuAds=items;
    var nSel=items.filter(function(x){return S.an.adSel[x.ad.row.i]}).length;
    var onCnt=items.filter(function(x){return C.normState(curVal(x.ad.row,c.state))==='enabled'}).length;
    var bar='<div class="subbatch"><b>'+nSel+'</b> 条已选'+
      '<button class="btn sm" data-adbatch="pause">关闭投放（暂停）</button>'+
      '<button class="btn sm" data-adbatch="enable">重新启用</button>'+
      '<button class="btn sm" data-adbatch="clear">取消选择</button>'+
      '<span class="subpick">快速选：'+
        '<span class="sgb" data-adpick="zero">花钱没单</span>'+
        '<span class="sgb" data-adpick="noimp">零曝光</span>'+
        '<span class="sgb" data-adpick="noclick">有曝光没点击</span>'+
        '<span class="sgb" data-adpick="highacos">ACOS 超 '+fp(S.cfg.targetAcos,0)+'</span>'+
        '<span class="sgb" data-adpick="all">全选</span></span></div>';
    return '<div class="subcap"><b>'+esc(o.key)+' 在 '+o.nc+' 条广告活动里的表现</b>'+seg+
      '<span>'+onCnt+' 条在投 · 关闭只影响这个 SKU 在该活动里的投放，不动活动本身</span></div>'+bar+
      '<table class="sub"><thead><tr><th style="width:26px"><input type="checkbox" data-adckall="1"></th>'+
      '<th>广告活动</th><th>广告组</th><th>状态</th>'+
      '<th class="r">曝光</th><th class="r">点击</th><th class="r">点击率</th><th class="r">花费</th><th class="r">订单</th>'+
      '<th class="r">转化率</th><th class="r">销售额</th><th class="r">ACOS</th><th class="r">CPC</th></tr></thead><tbody>'+
      items.map(function(x){
        var m=x.ad.m,st=C.normState(curVal(x.ad.row,c.state)),orig=C.normState(x.ad.row.d[c.state]);
        var off=st!=='enabled'&&orig==='enabled';
        return '<tr'+(off?' class="willoff"':'')+'><td><input type="checkbox" data-adck="'+x.ad.row.i+'"'+(S.an.adSel[x.ad.row.i]?' checked':'')+'></td>'+
          '<td style="max-width:280px;word-break:break-all"><a class="anlink" data-angoto="'+esc(x.cp.id)+'">'+esc(x.cp.name)+'</a>'+
          (off?'<span class="offmark">待关闭</span>':'')+'</td>'+
          '<td class="muted" style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(x.ad.adGroupName)+'">'+esc(x.ad.adGroupName)+'</td>'+
          '<td>'+stateSelect(x.ad.row)+'</td>'+
          '<td class="num">'+fi(m.imp)+'</td><td class="num">'+fi(m.clicks)+'</td><td class="num">'+fp(m.ctr,2)+'</td>'+
          '<td class="num">'+fm(m.spend)+'</td><td class="num">'+fi(m.orders)+'</td><td class="num">'+fp(m.cvr,1)+'</td>'+
          '<td class="num">'+fm(m.sales)+'</td><td class="num">'+facos(m)+'</td><td class="num">'+S.cur+m.cpc.toFixed(3)+'</td></tr>';
      }).join('')+'</tbody></table>';
  }

  /* ---------- 面板二：搜索词分析 ---------- */
  function anTermData(){
    var map={},q=S.an.q.toLowerCase();
    var gs=null,skuSet=null;
    if(S.an.sku){ gs=skuIndex().s2g[S.an.sku]||{}; skuSet={}; skuSet[S.an.sku]=1; }
    S.model.searchTerms.forEach(function(s){
      var cp=S.model.byCamp[s.campaignId];
      if(cp&&!anCampOk(cp))return;
      if(gs){
        if(!gs[s.adGroupId])return;
        if(S.an.skuOnlyEx&&!groupExclusive(s.adGroupId,skuSet))return;
      }
      if(q&&String(s.term).toLowerCase().indexOf(q)<0)return;
      var k=String(s.term).toLowerCase();
      var o=map[k]||(map[k]={term:s.term,items:[],camps:{}});
      o.items.push(s);o.camps[s.campaignId]=1;
    });
    return Object.keys(map).map(function(k){
      var o=map[k];o.m=C.sumMetrics(o.items.map(function(x){return x.m}));o.nc=Object.keys(o.camps).length;return o;
    });
  }
  function anTerm(){
    if(!S.model.searchTerms.length)
      return '<div class="empty">还没有搜索词数据。下载批量文件时勾选「搜索词报告」，或点右上角「载入搜索词报告」把后台单独导出的报告合并进来。</div>';
    var list=anTermData().filter(function(o){
      if(S.an.minClicks&&o.m.clicks<S.an.minClicks)return false;
      if(S.an.tf==='zero'&&(o.m.orders>0||o.m.spend<=0))return false;
      if(S.an.tf==='conv'&&o.m.orders<1)return false;
      if(S.an.tf==='multi'&&o.nc<2)return false;
      return true;
    });
    list=anSortList(list,function(o,k){
      if(k==='term')return String(o.term);
      if(k==='nc')return o.nc;
      return anMetricGet(o,k);
    });
    var sum=C.sumMetrics(list.map(function(o){return o.m}));
    var nSel=Object.keys(S.an.stSel).filter(function(k){return S.an.stSel[k]}).length;
    var bar='<div class="anbar">'+anPfOptions()+anSkuOptions()+
      (S.an.sku?'<label><input type="checkbox" id="anSkuEx"'+(S.an.skuOnlyEx?' checked':'')+'> 只看该 SKU 独占的广告组</label>':'')+
      '<input type="text" id="anQ" placeholder="搜索词包含…" value="'+esc(S.an.q)+'">'+
      '<label>最小点击 <input type="number" id="anMin" value="'+(S.an.minClicks||0)+'" min="0" style="width:64px"></label>'+
      '<div class="seg"><span class="sgb'+(!S.an.tf?' on':'')+'" data-antf="">全部</span>'+
        '<span class="sgb'+(S.an.tf==='zero'?' on':'')+'" data-antf="zero">花钱没单</span>'+
        '<span class="sgb'+(S.an.tf==='conv'?' on':'')+'" data-antf="conv">出过单</span>'+
        '<span class="sgb'+(S.an.tf==='multi'?' on':'')+'" data-antf="multi">多活动重复</span></div>'+
      '<div style="flex:1"></div><button class="btn sm" id="anCsv">导出本面板 CSV</button></div>'+
      (nSel?'<div class="anselbar"><b>'+nSel+'</b> 个词已选<button class="btn sm" id="anStBulk">批量否定这些词…</button>'+
        '<button class="btn sm" id="anStClear">取消选择</button></div>':'')+
      '<div class="anhint">同一个词在多条活动跑出来的数据已经合并。点行展开看它来自哪些活动、哪条投放。「否定」会写进这个词出现过的所有活动。'+
      (S.an.sku?'<br>已限定 <b>'+esc(S.an.sku)+'</b>：搜索词报告本身不带 SKU，这里是按这个 SKU 所在的广告组关联出来的'+
        (S.an.skuOnlyEx?'，且只保留了它独占的广告组，数据可以算在它头上。':'；广告组里还有别的 SKU 时，那条词的数据属于整个广告组，拆不到单个 SKU。'):'')+'</div>';
    if(!list.length)return bar+'<div class="empty">'+
      (S.an.sku&&S.an.skuOnlyEx?'「'+esc(S.an.sku)+'」没有独占的广告组——它所在的广告组里都还有别的 SKU 在跑，取消勾选可以看全部关联到的词。':'没有符合条件的搜索词')+'</div>';
    return bar+'<table class="tbl antbl"><thead><tr><th><input type="checkbox" data-anckall="1"></th>'+
      anTh('term','顾客搜索词')+anTh('nc','活动数',1)+mHeads()+'<th>否定</th></tr></thead><tbody>'+
      list.map(function(o,i){
        var k=String(o.term).toLowerCase();
        return '<tr class="anrow'+(isExp(k)?' expd':'')+'"><td><input type="checkbox" data-anck="'+esc(k)+'"'+(S.an.stSel[k]?' checked':'')+'></td>'+
          '<td class="anname" data-anexp="'+esc(k)+'" style="max-width:300px;word-break:break-all;cursor:pointer">'+esc(o.term)+'</td>'+
          '<td class="num">'+o.nc+'</td>'+mCells(o.m)+
          '<td>'+(anTermNegated(o)?'<span class="flagchip good">已加入否定</span>':
            '<button class="btn sm" data-anneg="'+i+'" data-match="phrase">词组</button> '+
            '<button class="btn sm" data-anneg="'+i+'" data-match="exact">精准</button>')+'</td></tr>'+
          (isExp(k)?anTermSub(o):'');
      }).join('')+
      '</tbody><tfoot><tr><td></td><td>合计 '+list.length+' 个词</td><td></td>'+mCells(sum)+'<td></td></tr></tfoot></table>';
  }
  function anTermNegated(o){
    return o.items.every(function(s){return alreadyNegated(s.campaignId,s.term)});
  }
  function anTermSub(o){
    var items=o.items.slice().sort(function(a,b){return b.m.spend-a.m.spend});
    return '<tr class="subrow"><td colspan="13"><div class="subwrap">'+
      '<div class="subcap"><b>「'+esc(o.term)+'」的来源</b><span>'+o.nc+' 条活动 · '+items.length+' 条投放</span></div>'+
      '<table class="sub"><thead><tr><th>广告活动</th><th>广告组</th><th>来源投放</th><th>匹配</th>'+
      '<th class="r">曝光</th><th class="r">点击</th><th class="r">点击率</th><th class="r">花费</th><th class="r">订单</th>'+
      '<th class="r">转化率</th><th class="r">销售额</th><th class="r">ACOS</th></tr></thead><tbody>'+
      items.map(function(s){
        return '<tr><td style="max-width:250px;word-break:break-all"><a class="anlink" data-angoto="'+esc(s.campaignId)+'">'+esc(s.campaignName)+'</a></td>'+
          '<td class="muted" style="max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(s.adGroupName)+'">'+esc(s.adGroupName)+'</td>'+
          '<td class="muted" style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(s.keywordText)+'">'+esc(s.keywordText)+'</td>'+
          '<td><span class="tag">'+esc(s.matchType||'-')+'</span></td>'+
          '<td class="num">'+fi(s.m.imp)+'</td><td class="num">'+fi(s.m.clicks)+'</td><td class="num">'+fp(s.m.ctr,2)+'</td>'+
          '<td class="num">'+fm(s.m.spend)+'</td><td class="num">'+fi(s.m.orders)+'</td><td class="num">'+fp(s.m.cvr,1)+'</td>'+
          '<td class="num">'+fm(s.m.sales)+'</td><td class="num">'+facos(s.m)+'</td></tr>';
      }).join('')+'</tbody></table></div></td></tr>';
  }

  /* ---------- 面板三：投放矩阵（同一个词跨活动） ---------- */
  function anKwData(){
    var map={},q=S.an.q.toLowerCase();
    S.model.campaigns.forEach(function(cp){
      if(!anCampOk(cp))return;
      cp.targets.forEach(function(t){
        var txt=String(t.text||'').trim();if(!txt)return;
        if(q&&txt.toLowerCase().indexOf(q)<0)return;
        var k=txt.toLowerCase();
        var o=map[k]||(map[k]={text:txt,items:[],camps:{},match:{}});
        o.items.push({cp:cp,t:t});o.camps[cp.id]=1;if(t.matchType)o.match[t.matchType]=1;
      });
    });
    return Object.keys(map).map(function(k){
      var o=map[k];o.m=C.sumMetrics(o.items.map(function(x){return x.t.m}));
      o.nc=Object.keys(o.camps).length;o.mt=Object.keys(o.match).join(' / ');return o;
    });
  }
  function anKw(){
    var list=anKwData().filter(function(o){
      if(S.an.minClicks&&o.m.clicks<S.an.minClicks)return false;
      if(S.an.kf==='multi'&&o.nc<2)return false;
      if(S.an.kf==='noimp'&&o.m.imp>0)return false;
      return true;
    });
    list=anSortList(list,function(o,k){
      if(k==='text')return String(o.text);
      if(k==='nc')return o.nc;
      return anMetricGet(o,k);
    });
    var sum=C.sumMetrics(list.map(function(o){return o.m}));
    var dup=list.filter(function(o){return o.nc>1}).length;
    var bar='<div class="anbar">'+anPfOptions()+
      '<input type="text" id="anQ" placeholder="搜投放词 / ASIN" value="'+esc(S.an.q)+'">'+
      '<label>最小点击 <input type="number" id="anMin" value="'+(S.an.minClicks||0)+'" min="0" style="width:64px"></label>'+
      '<div class="seg"><span class="sgb'+(!S.an.kf?' on':'')+'" data-ankf="">全部</span>'+
        '<span class="sgb'+(S.an.kf==='multi'?' on':'')+'" data-ankf="multi">多活动重复投</span>'+
        '<span class="sgb'+(S.an.kf==='noimp'?' on':'')+'" data-ankf="noimp">零曝光</span></div>'+
      '<div style="flex:1"></div><button class="btn sm" id="anCsv">导出本面板 CSV</button></div>'+
      '<div class="anhint">同一个词/定向在多条活动里的数据已合并，当前有 <b>'+dup+'</b> 个词投在两条以上活动里——这类词容易自己跟自己抬价，展开可以逐条比出价和表现，竞价直接改。</div>';
    if(!list.length)return bar+'<div class="empty">没有符合条件的投放</div>';
    return bar+'<table class="tbl antbl"><thead><tr>'+anTh('text','投放')+'<th>匹配类型</th>'+anTh('nc','活动数',1)+
      mHeads()+'</tr></thead><tbody>'+
      list.map(function(o){
        var k=String(o.text).toLowerCase();
        return '<tr class="anrow'+(o.nc>1?' mk-dup':'')+(isExp(k)?' expd':'')+'" data-anexp="'+esc(k)+'">'+
          '<td class="anname" style="max-width:300px;word-break:break-all">'+esc(o.text)+'</td>'+
          '<td><span class="tag">'+esc(o.mt||'-')+'</span></td><td class="num">'+o.nc+'</td>'+mCells(o.m)+'</tr>'+
          (isExp(k)?anKwSub(o):'');
      }).join('')+
      '</tbody><tfoot><tr><td>合计 '+list.length+' 个投放</td><td></td><td></td>'+mCells(sum)+'</tr></tfoot></table>';
  }
  function anKwSub(o){
    var c=S.model.colIdx;
    var items=o.items.slice().sort(function(a,b){return b.t.m.spend-a.t.m.spend});
    return '<tr class="subrow"><td colspan="12"><div class="subwrap">'+
      '<div class="subcap"><b>「'+esc(o.text)+'」分布在这些活动里</b><span>竞价和状态可以直接改</span></div>'+
      '<table class="sub"><thead><tr><th>广告活动</th><th>广告组</th><th>匹配</th><th>状态</th><th class="r">竞价</th>'+
      '<th class="r">曝光</th><th class="r">点击</th><th class="r">点击率</th><th class="r">花费</th><th class="r">订单</th><th class="r">转化率</th>'+
      '<th class="r">销售额</th><th class="r">ACOS</th><th class="r">CPC</th></tr></thead><tbody>'+
      items.map(function(x){
        var m=x.t.m,bid=(x.t.row.d[c.bid]!==null&&x.t.row.d[c.bid]!==undefined)?numInput(x.t.row,c.bid,'bid',0.01,0.02):'<span class="muted">组默认</span>';
        return '<tr><td style="max-width:250px;word-break:break-all"><a class="anlink" data-angoto="'+esc(x.cp.id)+'">'+esc(x.cp.name)+'</a></td>'+
          '<td class="muted" style="max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(x.t.adGroupName)+'">'+esc(x.t.adGroupName)+'</td>'+
          '<td><span class="tag">'+esc(x.t.matchType)+'</span></td><td>'+stateSelect(x.t.row)+'</td><td class="num">'+bid+'</td>'+
          '<td class="num">'+fi(m.imp)+'</td><td class="num">'+fi(m.clicks)+'</td><td class="num">'+fp(m.ctr,2)+'</td>'+
          '<td class="num">'+fm(m.spend)+'</td><td class="num">'+fi(m.orders)+'</td><td class="num">'+fp(m.cvr,1)+'</td>'+
          '<td class="num">'+fm(m.sales)+'</td><td class="num">'+facos(m)+'</td><td class="num">'+S.cur+m.cpc.toFixed(3)+'</td></tr>';
      }).join('')+'</tbody></table></div></td></tr>';
  }

  /* ---------- 面板四：广告位汇总 ---------- */
  function anPl(){
    var ord=['top','ros','pp','biz','other'],map={};
    S.model.campaigns.forEach(function(cp){
      if(!anCampOk(cp))return;
      cp.placements.forEach(function(pl){
        if(!pl.raw)return;
        var o=map[pl.key]||(map[pl.key]={key:pl.key,label:pl.label,items:[]});
        o.items.push({cp:cp,pl:pl});
      });
    });
    var list=ord.filter(function(k){return map[k]}).map(function(k){
      var o=map[k];o.m=C.sumMetrics(o.items.map(function(x){return x.pl.m}));
      var pcts=o.items.map(function(x){return C.num(curVal(x.pl.row,S.model.colIdx.percentage))}).filter(function(v){return v>0});
      o.avgPct=pcts.length?pcts.reduce(function(a,b){return a+b},0)/pcts.length:0;
      o.nPct=pcts.length;return o;
    });
    var sum=C.sumMetrics(list.map(function(o){return o.m}));
    var bar='<div class="anbar">'+anPfOptions()+'<div style="flex:1"></div><button class="btn sm" id="anCsv">导出本面板 CSV</button></div>'+
      '<div class="anhint">四个广告位在全店的整体效率对比。展开看哪些活动在这个位置上花得最多，溢价可以直接改。</div>';
    if(!list.length)return bar+'<div class="empty">没有广告位数据</div>';
    return bar+'<table class="tbl antbl"><thead><tr><th>广告位</th><th class="r">平均溢价</th><th class="r">花费占比</th>'+
      '<th class="r">曝光</th><th class="r">点击</th><th class="r">点击率</th><th class="r">花费</th><th class="r">订单</th>'+
      '<th class="r">转化率</th><th class="r">销售额</th><th class="r">ACOS</th><th class="r">CPC</th></tr></thead><tbody>'+
      list.map(function(o){
        return '<tr class="anrow'+(isExp(o.key)?' expd':'')+'" data-anexp="'+esc(o.key)+'">'+
          '<td class="anname">'+esc(o.label)+'</td>'+
          '<td class="num">'+(o.nPct?o.avgPct.toFixed(0)+'%':'—')+'</td>'+
          '<td class="num">'+fp(sum.spend?o.m.spend/sum.spend:0,1)+'</td>'+mCells(o.m)+'</tr>'+
          (isExp(o.key)?anPlSub(o):'');
      }).join('')+
      '</tbody><tfoot><tr><td>合计</td><td></td><td class="num">100%</td>'+mCells(sum)+'</tr></tfoot></table>';
  }
  function anPlSub(o){
    var c=S.model.colIdx;
    var items=o.items.slice().sort(function(a,b){return b.pl.m.spend-a.pl.m.spend||b.pl.m.imp-a.pl.m.imp}).slice(0,60);
    return '<tr class="subrow"><td colspan="12"><div class="subwrap">'+
      '<div class="subcap"><b>'+esc(o.label)+' · 按花费排前 '+items.length+' 条活动</b><span>溢价可以直接改</span></div>'+
      '<table class="sub"><thead><tr><th>广告活动</th><th class="r">溢价 %</th>'+
      '<th class="r">曝光</th><th class="r">点击</th><th class="r">点击率</th><th class="r">花费</th><th class="r">订单</th>'+
      '<th class="r">转化率</th><th class="r">销售额</th><th class="r">ACOS</th><th class="r">CPC</th></tr></thead><tbody>'+
      items.map(function(x){
        var m=x.pl.m;
        return '<tr><td style="max-width:320px;word-break:break-all"><a class="anlink" data-angoto="'+esc(x.cp.id)+'">'+esc(x.cp.name)+'</a></td>'+
          '<td class="num">'+numInput(x.pl.row,c.percentage,'percentage',5,0)+'</td>'+
          '<td class="num">'+fi(m.imp)+'</td><td class="num">'+fi(m.clicks)+'</td><td class="num">'+fp(m.ctr,2)+'</td>'+
          '<td class="num">'+fm(m.spend)+'</td><td class="num">'+fi(m.orders)+'</td><td class="num">'+fp(m.cvr,1)+'</td>'+
          '<td class="num">'+fm(m.sales)+'</td><td class="num">'+facos(m)+'</td><td class="num">'+S.cur+m.cpc.toFixed(3)+'</td></tr>';
      }).join('')+'</tbody></table></div></td></tr>';
  }

  /* ---------- 面板五：广告组合汇总 ---------- */
  function anPfPanel(){
    var map={};
    S.model.campaigns.forEach(function(cp){
      var k=cp.portfolio||'（无组合）';
      var o=map[k]||(map[k]={key:k,items:[]});
      o.items.push(cp);
    });
    var list=Object.keys(map).map(function(k){
      var o=map[k];o.m=C.sumMetrics(o.items.map(function(x){return x.m}));
      o.nc=o.items.length;
      o.on=o.items.filter(function(x){return x.state==='enabled'}).length;
      return o;
    });
    list=anSortList(list,function(o,k){
      if(k==='key')return String(o.key);
      if(k==='nc')return o.nc;
      return anMetricGet(o,k);
    });
    var sum=C.sumMetrics(list.map(function(o){return o.m}));
    var bar='<div class="anbar"><div style="flex:1"></div><button class="btn sm" id="anCsv">导出本面板 CSV</button></div>'+
      '<div class="anhint">按广告组合汇总花费与效率。展开看组合里每条活动，点活动名跳到优化视图。</div>';
    return bar+'<table class="tbl antbl"><thead><tr>'+anTh('key','广告组合')+anTh('nc','活动数',1)+
      '<th class="r">花费占比</th>'+mHeads()+'</tr></thead><tbody>'+
      list.map(function(o){
        return '<tr class="anrow'+(isExp(o.key)?' expd':'')+'" data-anexp="'+esc(o.key)+'">'+
          '<td class="anname">'+esc(o.key)+'</td><td class="num">'+o.on+' / '+o.nc+'</td>'+
          '<td class="num">'+fp(sum.spend?o.m.spend/sum.spend:0,1)+'</td>'+mCells(o.m)+'</tr>'+
          (isExp(o.key)?anPfSub(o):'');
      }).join('')+
      '</tbody><tfoot><tr><td>合计</td><td></td><td class="num">100%</td>'+mCells(sum)+'</tr></tfoot></table>';
  }
  function anPfSub(o){
    var items=o.items.slice().sort(function(a,b){return b.m.spend-a.m.spend});
    return '<tr class="subrow"><td colspan="12"><div class="subwrap">'+
      '<div class="subcap"><b>'+esc(o.key)+' 里的 '+items.length+' 条活动</b><span>点活动名跳回优化视图</span></div>'+
      '<table class="sub"><thead><tr><th>广告活动</th><th>状态</th><th class="r">预算</th>'+
      '<th class="r">曝光</th><th class="r">点击</th><th class="r">点击率</th><th class="r">花费</th><th class="r">订单</th>'+
      '<th class="r">转化率</th><th class="r">销售额</th><th class="r">ACOS</th></tr></thead><tbody>'+
      items.map(function(cp){
        var m=cp.m;
        return '<tr><td><a class="anlink" data-angoto="'+esc(cp.id)+'">'+esc(cp.name)+'</a></td>'+
          '<td class="muted">'+(cp.state==='paused'?'已暂停':cp.state==='archived'?'已存档':'已启用')+'</td>'+
          '<td class="num">'+(cp.budget?fm(C.num(cp.budget)):'—')+'</td>'+
          '<td class="num">'+fi(m.imp)+'</td><td class="num">'+fi(m.clicks)+'</td><td class="num">'+fp(m.ctr,2)+'</td>'+
          '<td class="num">'+fm(m.spend)+'</td><td class="num">'+fi(m.orders)+'</td><td class="num">'+fp(m.cvr,1)+'</td>'+
          '<td class="num">'+fm(m.sales)+'</td><td class="num">'+facos(m)+'</td></tr>';
      }).join('')+'</tbody></table></div></td></tr>';
  }

  /* ---------- 渲染与事件 ---------- */
  var AN_TABS=[['sku','SKU 矩阵'],['term','搜索词分析'],['kw','投放矩阵'],['pl','广告位汇总'],['pf','组合汇总']];
  function anBody(){
    if(S.an.tab==='sku')return anSku();
    if(S.an.tab==='term')return anTerm();
    if(S.an.tab==='kw')return anKw();
    if(S.an.tab==='pl')return anPl();
    return anPfPanel();
  }
  function renderAnalysis(){
    if(!S.model)return;
    $('#antabs').innerHTML=AN_TABS.map(function(t){
      return '<div class="tab'+(S.an.tab===t[0]?' on':'')+'" data-antab="'+t[0]+'">'+t[1]+'</div>'}).join('');
    $('#anbody').innerHTML=anBody();
    var bar=$('#anbody .anbar'), h=bar?bar.offsetHeight:0;
    if(h)$$('#anbody > table.antbl > thead > tr > th').forEach(function(th){th.style.top=h+'px'});
  }
  function setView(v){
    S.view=v;
    $$('.vbtn').forEach(function(b){b.classList.toggle('on',b.dataset.view===v)});
    $('#main').style.display=v==='work'?'grid':'none';
    $('#analysis').style.display=v==='work'?'none':'flex';
    if(v==='analysis')renderAnalysis();
  }
  $$('.vbtn').forEach(function(b){b.onclick=function(){ if(!S.model){toast('先载入批量表');return;} setView(b.dataset.view); }});

  $('#analysis').addEventListener('click',function(e){
    var t=e.target.closest('[data-antab]');
    if(t){S.an.tab=t.dataset.antab;S.an.q='';S.an.minClicks=0;renderAnalysis();return}
    var by=e.target.closest('[data-anby]');
    if(by){S.an.byAsin=by.dataset.anby==='asin';S.an.exp={};renderAnalysis();return}
    var mk=e.target.closest('[data-anmark]');
    if(mk){S.an.mark=mk.dataset.anmark;renderAnalysis();return}
    var tf=e.target.closest('[data-antf]');
    if(tf){S.an.tf=tf.dataset.antf;renderAnalysis();return}
    var kf=e.target.closest('[data-ankf]');
    if(kf){S.an.kf=kf.dataset.ankf;renderAnalysis();return}
    var ap=e.target.closest('[data-adpick]');
    if(ap){
      var op=ap.dataset.adpick;
      S.an._skuAds.forEach(function(x){
        var m=x.ad.m,hit=false;
        if(op==='all')hit=true;
        else if(op==='zero')hit=m.orders===0&&m.spend>0;
        else if(op==='noimp')hit=m.imp===0;
        else if(op==='noclick')hit=m.imp>0&&m.clicks===0;
        else if(op==='highacos')hit=m.sales>0&&m.acos>S.cfg.targetAcos;
        if(hit)S.an.adSel[x.ad.row.i]=1;
      });
      renderAnalysis();return;
    }
    var ab=e.target.closest('[data-adbatch]');
    if(ab){
      var c3=S.model.colIdx,w=stateWords(),op2=ab.dataset.adbatch;
      if(op2==='clear'){S.an.adSel={};renderAnalysis();return}
      var ids=Object.keys(S.an.adSel).filter(function(k){return S.an.adSel[k]});
      if(!ids.length){toast('先勾选要处理的活动');return}
      var want=op2==='pause'?'paused':'enabled',hit=0,same=0;
      ids.forEach(function(i){
        var row=S.model.rows[+i];if(!row)return;
        if(C.normState(curVal(row,c3.state))===want){same++;return}
        setVal(row,c3.state,op2==='pause'?w.paused:w.enabled,'state');hit++;
      });
      S.an.adSel={};
      toast(hit?((op2==='pause'?'已关闭 ':'已重新启用 ')+hit+' 条投放'+(same?'（'+same+' 条本来就是）':'')+'，导出后生效')
               :'这些投放本来就是'+(op2==='pause'?'关闭':'启用')+'状态');
      renderAnalysis();return;
    }
    var ss=e.target.closest('[data-skusub]');
    if(ss){var v=ss.dataset.skusub,i=v.indexOf('|');S.an.skuSub[v.slice(i+1)]=v.slice(0,i);S.an.adSel={};renderAnalysis();return}
    var se=e.target.closest('[data-skuexcl]');
    if(se){var v2=se.dataset.skuexcl,j=v2.indexOf('|');S.an.skuExcl[v2.slice(j+1)]=v2.slice(0,j)==='1';renderAnalysis();return}
    var sn=e.target.closest('[data-skuneg]');
    if(sn){
      var e2=S.an._skuStList[+sn.dataset.skuneg];if(!e2)return;
      var added=0;
      e2.items.forEach(function(x){
        var cp2=S.model.byCamp[x.campaignId];if(!cp2)return;
        var ok=S.changes.addNegative(x.adGroupId
          ?{kind:'negKeyword',campaignId:x.campaignId,adGroupId:x.adGroupId,text:x.term,match:sn.dataset.match,
            campaignName:x.campaignName||cp2.name,adGroupName:x.adGroupName}
          :{kind:'campNegKw',campaignId:x.campaignId,adGroupId:'',text:x.term,match:sn.dataset.match,
            campaignName:x.campaignName||cp2.name,adGroupName:''});
        if(ok)added++;
      });
      toast(added?'已在 '+added+' 处加入否定：'+e2.term:'这个词已经加过了');
      renderFoot();renderAnalysis();return;
    }
    var hd=e.target.closest('th[data-ansort]');
    if(hd){
      var k=hd.dataset.ansort,s=S.an.sort[S.an.tab];
      if(s&&s.k===k)s.d=-s.d;else S.an.sort[S.an.tab]={k:k,d:(k==='key'||k==='text'||k==='term')?1:-1};
      renderAnalysis();return;
    }
    var goto=e.target.closest('[data-angoto]');
    if(goto){S.sel=goto.dataset.angoto;S.checked={};S.expT={};setView('work');renderRail();renderDetail();
      var row=$('#raillist .crow.sel');if(row&&row.scrollIntoView)row.scrollIntoView({block:'center'});return}
    var ng=e.target.closest('[data-anneg]');
    if(ng){
      var list=anTermData().filter(function(o){
        if(S.an.minClicks&&o.m.clicks<S.an.minClicks)return false;
        if(S.an.tf==='zero'&&(o.m.orders>0||o.m.spend<=0))return false;
        if(S.an.tf==='conv'&&o.m.orders<1)return false;
        if(S.an.tf==='multi'&&o.nc<2)return false;
        return true;
      });
      list=anSortList(list,function(o,k){if(k==='term')return String(o.term);if(k==='nc')return o.nc;return anMetricGet(o,k)});
      var o2=list[+ng.dataset.anneg];if(!o2)return;
      var added=0;
      o2.items.forEach(function(s){
        var cp=S.model.byCamp[s.campaignId];if(!cp)return;
        var ok=S.changes.addNegative(s.adGroupId
          ?{kind:'negKeyword',campaignId:s.campaignId,adGroupId:s.adGroupId,text:s.term,match:ng.dataset.match,
            campaignName:s.campaignName||cp.name,adGroupName:s.adGroupName}
          :{kind:'campNegKw',campaignId:s.campaignId,adGroupId:'',text:s.term,match:ng.dataset.match,
            campaignName:s.campaignName||cp.name,adGroupName:''});
        if(ok)added++;
      });
      toast(added?'已在 '+added+' 处加入否定：'+o2.term:'这个词已经加过了');
      renderFoot();renderAnalysis();return;
    }
    if(e.target.id==='anStClear'){S.an.stSel={};renderAnalysis();return}
    if(e.target.id==='anStBulk'){anStBulk();return}
    if(e.target.id==='anCsv'){anCsv();return}
    var ex=e.target.closest('[data-anexp]');
    if(ex&&!e.target.closest('input,select,button,a')){
      var key=anExpKey(ex.dataset.anexp);
      if(S.an.exp[key])delete S.an.exp[key];else S.an.exp[key]=1;
      S.an.adSel={};renderAnalysis();return;
    }
  });
  $('#analysis').addEventListener('change',function(e){
    var el=e.target;
    if(el.id==='anPf'){S.an.pf=el.value;S.an.exp={};renderAnalysis();return}
    if(el.id==='anMin'){S.an.minClicks=parseFloat(el.value)||0;renderAnalysis();return}
    if(el.id==='anSku'){S.an.sku=el.value;if(!el.value)S.an.skuOnlyEx=false;renderAnalysis();return}
    if(el.dataset.adckall!==undefined){
      S.an._skuAds.forEach(function(x){S.an.adSel[x.ad.row.i]=el.checked});
      renderAnalysis();return;
    }
    if(el.dataset.adck!==undefined){S.an.adSel[el.dataset.adck]=el.checked;renderAnalysis();return}
    if(el.id==='anSkuEx'){S.an.skuOnlyEx=el.checked;renderAnalysis();return}
    if(el.dataset.anckall!==undefined){
      $$('#anbody [data-anck]').forEach(function(b){b.checked=el.checked;S.an.stSel[b.dataset.anck]=el.checked});
      renderAnalysis();return;
    }
    if(el.dataset.anck!==undefined){S.an.stSel[el.dataset.anck]=el.checked;renderAnalysis();return}
    if(el.dataset.ri!==undefined){
      var row=S.model.rows[+el.dataset.ri],col=+el.dataset.col,field=el.dataset.field;
      var val=el.dataset.map==='state'?el.value:(el.value===''?null:parseFloat(el.value));
      if(field==='percentage'&&val!==null)val=Math.round(val);
      setVal(row,col,val,field);
      el.classList.toggle('dirty',S.changes.get(row.i,col)!==undefined);
      if(field==='state')renderAnalysis();
    }
  });
  $('#analysis').addEventListener('input',function(e){
    if(e.target.id==='anQ'){
      S.an.q=e.target.value.trim();
      clearTimeout(S._anT);
      S._anT=setTimeout(function(){
        renderAnalysis();
        var f=$('#anQ');if(f){f.focus();f.setSelectionRange(f.value.length,f.value.length)}
      },260);
    }
  });
  function anStBulk(){
    var picked=Object.keys(S.an.stSel).filter(function(k){return S.an.stSel[k]});
    if(!picked.length){toast('先勾选搜索词');return}
    var all=anTermData(),words=[],camps={};
    all.forEach(function(o){
      if(picked.indexOf(String(o.term).toLowerCase())<0)return;
      words.push(o.term);
      o.items.forEach(function(s){camps[s.campaignId]=1});
    });
    S.bnSel={};Object.keys(camps).forEach(function(id){S.bnSel[id]=1});
    openBneg();
    $('#bnText').value=words.join('\n');
    renderBnSum();
  }
  function anCsv(){
    var tbl=$('#anbody table');
    if(!tbl){toast('当前面板没有可导出的表格');return}
    var rows=[];
    Array.prototype.forEach.call(tbl.querySelectorAll('tr'),function(tr){
      if(tr.closest('.subrow'))return;
      var cells=Array.prototype.map.call(tr.children,function(td){
        var inp=td.querySelector('input[type=number],select');
        if(inp)return inp.value;
        if(td.querySelector('input[type=checkbox]'))return '';
        return (td.textContent||'').replace(/[▲▼]/g,'').replace(/\s+/g,' ').trim();
      });
      if(cells.join('').trim())rows.push(cells);
    });
    var name=(AN_TABS.filter(function(t){return t[0]===S.an.tab})[0]||['',''])[1];
    var csv=rows.map(function(r){return r.map(function(v){return '"'+String(v).replace(/"/g,'""')+'"'}).join(',')}).join('\r\n');
    download(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}),exportName('csv').replace('批量优化',name));
  }


  /* ---------- 渲染入口 ---------- */
  function renderAll(){ if(!S.model)return; renderKpi(); renderRail(); renderDetail(); renderFoot(); if(S.view==='analysis')renderAnalysis(); }
  on(window,'beforeunload',function(e){ if(S.changes.count()){ e.preventDefault(); e.returnValue=''; } });

  /* ================= 搜索词 / 周期名 =================
     搜索词原始行存在 S.terms 里(按天下载的报告一个词有很多行),
     上界面前按活动 / 投放 / 词合并成整期一行。 */

  function setTerms(list){
    S.terms=list;
    S.model.searchTerms=C.mergeSearchTerms(list);
    S.model._stIdx=null; S.model._skuIdx=null;
  }
  /* 同一份报告重复载入时按原始行覆盖,指标不会翻倍 */
  function mergeStReport(d){
    var key=function(x){return x.campaignId+'|'+x.targetId+'|'+String(x.term).toLowerCase()+'|'+(x.date||'')};
    var map={};
    S.terms.forEach(function(x){ map[key(x)]=x });
    d.terms.forEach(function(x){ map[key(x)]=x });
    setTerms(Object.keys(map).map(function(k){return map[k]}));
    S.stRptName=d.file;
    if(!S.periodTouched&&!$('#periodA').value)autoPeriodLabel('');
    renderAll();
    toast('已并入 '+d.matched+' 条搜索词'+(d.unmatched?'（'+d.unmatched+' 条没匹配到活动，已跳过）':''));
  }
  /* 导出文件名里的周期:先认文件名,认不出就拿搜索词报告的日期兜底,用户自己写过就不动 */
  function autoPeriodLabel(fileName){
    if(S.periodTouched)return;
    var el=$('#periodA'); if(!el)return;
    var g=C.parsePeriodFromName(fileName||'');
    if(!g.start&&!g.end)g=C.dateSpan(S.terms);
    el.value=C.periodLabel(g.start,g.end);
  }
  $('#periodA').addEventListener('input',function(){ S.periodTouched=true });


  function unmount() {
    offs.forEach((f) => f());
    clearTimeout(S._anT);
    clearTimeout(S._bnT);
    const t = root.querySelector('#toast');
    if (t) clearTimeout(t._t);
    root.innerHTML = '';
  }

  return { unmount: unmount, setLibrary: setLibrary };
}
