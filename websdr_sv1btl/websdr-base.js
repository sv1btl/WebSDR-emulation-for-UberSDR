var circle
var radius
var circumference
var divRing

// variables governing what the user listens to:
var lo=-2.76,hi=-0.15;   // active edges of passband, in kHz w.r.t. the carrier
var mode="LSB";        // 1 if AM, 0 otherwise (SSB/CW); or text "AM", "FM" etc
var band=0;            // id of the band we're listening to

// passband settings for various modes
var cwlo=-0.95, cwhi=-0.55; //CW
var cwnlo=-0.78, cwnhi=-0.72; //CW Narrow
var cwwlo=-1.05, cwwhi=-0.45; //CW Wide

var lsblo=-2.76, lsbhi=-0.15;  //LSB
var lsbnlo=-2.31, lsbnhi=-0.1;  //LSB Narrow
var lsbwlo=-3.81, lsbwhi=-0.1;  //LSB Wide

var usblo=0.15, usbhi=2.76;    //USB
var usbnlo=0.1, usbnhi=2.31;    //USB Narrow
var usbwlo=0.1, usbwhi=3.81;    //USB Wide

var amlo=-4.455, amhi=4.455;  //AM
var amnlo=-2.955, amnhi=2.955;  //AM Narrow
var amwlo=-4.9555, amwhi=4.955;  //AM Wide

var fmlo=-4.95, fmhi=4.96;  //FM
var fmnlo=-3.20, fmnhi=3.21;  //FM Narrow
var fmwlo=-6.20, fmwhi=6.21;  //FM Wide

var freq=freq=bandinfo[0].vfo;  // frequency (of the carrier) in kHz
var memories = [ ];
var initmodeflag=0; 	// Flag to determine the mode to use each time the page is reloaded
// used for setting initial audio buffering depth

// repeat for the "other" "vfo" (a/b toggle)
var ab_lo=lo;
var ab_hi=hi;
var ab_mode=mode;
var ab_band=band;
var ab_freq=freq;
var ab_squelch=false;
var mem_hilite=-1;
var ab_mem_hilite=-1;

// variables governing what the user sees:
var Views={ allbands:0, othersslow:1, oneband:2, blind:3 };
var view=Views.blind;
var nwaterfalls=0;
var waterslowness=4;
var waterheight=100;
var watermode=1;
var scaleheight=14;

// timers:
var interval_updatesmeter;
var interval_ajax3;
var timeout_idle;
var setfreqif_fut_timer;  // timer for typing in the frequency field

var samplecount=0;
var windowhours=0;
var windowmins=0;
var windowsecs=0;

// information about the available "virtual" bands:
// contains: effsamplerate, effcenterfreq, zoom, start, minzoom, maxzoom, samplerate, centerfreq, vfo, scaleimgs, realband
var bi = new Array();
// number of bands:
var nvbands=nbands;

// variables governing what the user listens to:
var geo="";
var udkflag=0;
var cw_offset=0;		//offset used in tunestep evaluation if cw
var tune_step=0;
var tune_old=0;
var fRND=3700;
var fRAW=3700;

// references to objects on the screen:
var scaleobj;
var scaleobjs = new Array();
var scaleimgs0 = new Array();
var scaleimgs1 = new Array();
var passbandobj;
var edgelowerobj;
var edgeupperobj;
var carrierobj;
var smeterobj;
var smeterobjnew;
var numericalsmeterobj;
var smeterpeakobj;
var numericalsmeterpeakobj;
var waterfallapplet = new Array();
var soundapplet = null;

// references to objects on the screen:
var smeterminobj;	//used in noise metrics
var snrobj;
var noise=0;		//used in noise metrics
var snr=1;		//used in noise metrics

// misc
var serveravailable=-1;  // -1 means yet to be tested, 0 and 1 mean false and true
var smeterpeaktimer=2;
var smeterpeak=0;    
var smetermintimer=2;	//initialises noise window timer
var smetermin=3000;	//initalises min level (updates recusrively during window)

var allloadeddone=false;
var waitingforwaterfalls=0;  // number of waterfallapplets that are still in the process of starting
var band_fetchdxtimer=new Array();
var hidedx=0;
var usejavawaterfall=1;
var usejavasound=1;
var javaerr=0;
var isTouchDev = false;

// derived quantities:
var khzperpixel=bandinfo[band].samplerate/1024;
var passbandobjstart=0;    // position (in pixels) of start of passband on frequency axis, w.r.t. location of carrier
var passbandobjwidth=0;    // width of passband in pixels
var centerfreq=bandinfo[band].centerfreq;

var band0_smeter_offset = 700;   // SV1BTL 2026-10-01: was 1200 (+12 dB); now +7 dB
var band1_smeter_offset = 1000;
var band2_smeter_offset = 1000;
var band3_smeter_offset = 1000;
var band4_smeter_offset = 1000;
var band5_smeter_offset = 1000;
var band6_smeter_offset = 1000;
var band7_smeter_offset = 1000;

function bodyonload()
{
	if (x!=null)
   {
     console.log(x);
     if (x.length > 10 || /\s+/.test(document.usernameform.username.value))
     {
       ip2geo('visited');
       x="";
     }
   }
   var s;
   html5orjavamenu();
   if ((sup_iOS || sup_android) && has_mobile) document.getElementById("mobilewarning").style.display= "block";

   view= readCookie('view');
   if (view==null) view=Views.oneband;
      if (nvbands>=2) s= '<input class="radios" type="radio" name="group" id="radio-1" value="all bands" onclick="setview(0);"><label for="radio-1">All Bands</label><input class="radios" type="radio" name="group" id="radio-4" value="other slow" onclick="setview(1);" style="display:none"><label for="radio-4"style="display:none"> other slow</label><input class="radios" type="radio" name="group" id="radio-2" value="one band" onclick="setview(2);"><label for="radio-2">Single band</label>';
   else {
      s='<input class="radios" type="radio" name="group" id="radio-2" value="one band" onclick="setview(2);"><label for="radio-2">Single band</label>';
      if (view==Views.othersslow || view==Views.allbands) view=Views.oneband;
   }
   s+='<input class="radios" type="radio" name="group" id="radio-3" value="blind" onclick="setview(3);"><label for="radio-3">off</label>';
   document.getElementById('viewformbuttons').innerHTML = s;
   if (nvbands>=2) document.viewform.group[view].checked=true;
   else document.viewform.group[view-2].checked=true;

   var x= readCookie('username');
   
   var p=document.getElementById("please2");
   if (!x && p) p.innerHTML="<b><i>Please type a name or callsign in the box at the <a href='#please'>top of the page</a> to identify your chat messages!</i></b>";

   uu_compactview=document.getElementById("compactviewcheckbox").checked;
   document.getElementById("mutecheckbox").checked=false;
   document.getElementById("squelchcheckbox").checked=false;
   document.getElementById("autonotchcheckbox").checked=false;

   try { memories=JSON.parse(localStorage.getItem('memories')); } catch (e) {};
   if (!memories) memories=[];
   else {
       // conversion from old data format - should be removed later
       var rew=false;
       for (i=0;i<memories.length;i++) {
          if (memories[i].mode==1) { memories[i].mode="AM"; rew=true; }
          if (memories[i].mode==4) { memories[i].mode="FM"; rew=true; }
          if (memories[i].mode==0) {
             rew=true;
             if (memories[i].hi-memories[i].lo<1) memories[i].mode="CW";
             else if (memories[i].hi+memories[i].lo>0) memories[i].mode="USB";
             else memories[i].mode="LSB";
          }
          if (!memories[i].nomfreq) memories[i].nomfreq=memories[i].freq + (memories[i].mode=="CW"?0.75:0);
       }
       if (rew) try { localStorage.setItem('memories',JSON.stringify(memories)); } catch (e) {};
   }
   mem_show();
   passbandobj =document.getElementById('yellowbar');
   edgeupperobj = document.getElementById('edgeupper');
   edgelowerobj = document.getElementById('edgelower');
   edgeupperobj = document.getElementById('edgeupper');
   carrierobj = document.getElementById('carrier');
   smeterobj = document.getElementById('smeterbar');
   smeterobjnew = document.getElementById('smeterbarnew');
   numericalsmeterobj=document.getElementById('numericalsmeter');
   smeterpeakobj = document.getElementById('smeterpeak');
   smeterminobj = document.getElementById('smetermin');
   snrobj = document.getElementById('snr_info');
   numericalsmeterpeakobj=document.getElementById('numericalsmeterpeak');
   smeterobj.style.top= smeterpeakobj.style.top;
   smeterobj.style.left= smeterpeakobj.style.left;
   divRing = document.getElementsByClassName('progress-ring')[0]

   bi=bandinfo;
   for (i=0;i<nbands;i++) {
      var e=bi[i];
      e.realband=i;
      e.effcenterfreq=e.centerfreq;
      e.effsamplerate=e.samplerate;
      e.zoom=0;
      e.start=0;
      e.minzoom=0;
   }

   document.freqform.frequency.value=freq;
   if (nbands>1) document.freqform.group0[0].checked=true;

   html5javawarn();

   chatboxobj = document.getElementById('chatbox');

   statsobj = document.getElementById('stats');
   numusers1obj = document.getElementById('numusers1');
   numusersobj = document.getElementById('numusers');
   usersobj = document.getElementById('users');

   setview(view);

   if (!islsbband(band) && hi<0) { var tmp=hi; hi=-lo; lo=-tmp; mode="USB"; }
   var tuneparam = (new RegExp("[?&]tune=([^&#]*)").exec(window.location.href));
   if (tuneparam) {
      setfreqtune(tuneparam[1]);
   } else if (ini_freq && ini_mode) {
      setfreqif(ini_freq);
      set_mode(ini_mode);


   }

   document_soundapplet();

   interval_ajax3 = setTimeout('ajaxFunction3()',1000);

   setTimeout('javatest()',2000);

   interval_updatesmeter = setInterval('updatesmeter()',100);

   if (isTouchDev) {
      registerTouchEvents("carrier", touchpassband, touchXYpassband);
      registerTouchEvents("yellowbar", touchpassband, touchXYpassband);
      registerTouchEvents("edgeupper", touchupper, touchXYupperedge);
      registerTouchEvents("edgelower", touchlower, touchXYloweredge);
   }
   settings_recall();
   // equipment shade
	$("#equip_button").click(function(){
	  $("#equip_info").slideToggle();
	});
	$(".band_offed").click(function () {
		$(".notify").toggleClass("active");
		$("#notifyType").toggleClass("success");

		setTimeout(function(){
			$(".notify").removeClass("active");
			$("#notifyType").removeClass("success");
		},3000);
		});
	// MagicEye
	circle = document.querySelectorAll('circle');
	radius = circle[0].r.baseVal.value;
	circumference = radius * 2 * Math.PI;

	circle[0].style.strokeDasharray = `${circumference} ${circumference}`;
	circle[0].style.strokeDashoffset = `${circumference}`;
	circle[1].style.strokeDasharray = `${circumference} ${circumference}`;
	circle[1].style.strokeDashoffset = -`${circumference}`;
}

// MagicEye
function setProgress(percent) {
	  const offset = circumference - percent / 100 * circumference;
	  circle[0].style.strokeDashoffset = offset;
	  circle[1].style.strokeDashoffset = -offset;
	}

function cancelEvent(e)
{
  e = e ? e : window.event;
  if(e.stopPropagation) e.stopPropagation();
  if(e.preventDefault) e.preventDefault();
  e.cancelBubble = true;
  e.cancel = true;
  e.returnValue = false;
  return false;
}

function timeout_idle_do()
{
   try { clearInterval(interval_updatesmeter); } catch (e) {} ;
   try { clearTimeout(interval_ajax3); } catch (e) {} ;
   var i;
   try { for (i=0;i<nwaterfalls;i++) waterfallapplet[i].destroy(); } catch (e) {} ;
   try { soundapplet.destroy(); } catch (e) {};
   document.body.innerHTML="Idle time out.\n";
}


function timeout_idle_restart()
{
   if (!idletimeout) return;
   try { clearTimeout(timeout_idle); } catch(e) {};
   timeout_idle=setTimeout('timeout_idle_do();',idletimeout);
}

function send_soundsettings_to_server()
{
  var m=mode;
  if (m=="USB") m=0;
  else if (m=="LSB") m=0;
  else if (m=="CW") m=0;
  else if (m=="AM") m=1;
  else if (m=="FM") m=4;
  var freq_corr_cw=freq;
  if (mode=="CW") {freq_corr_cw=freq+(hi+lo)/2;}
  try {
     soundapplet.setparam(
         "f="+freq
        +"&band="+band
        +"&lo="+lo
        +"&hi="+hi
        +"&mode="+m
        +"&name="+encodeURIComponent(document.usernameform.username.value)+"%20"+(+freq).toFixed(2)
        );
        // PA0SIM add frequency to waterfall
  } catch (e) {};
  timeout_idle_restart()
}

function setsquelch(a)
{
   a=Number(a);
   soundapplet.setparam("squelch="+a);
   // PA0SIM work around for squelch btter handling electric fence pulses for SSB
   if (a==1) {
        if (mode=="LSB") {lsbhi= 0.005; usblo=-0.005; hi= 0.005;}  // for both modes the memory setting
        if (mode=="USB") {lsbhi= 0.005; usblo=-0.005; lo=-0.005;}
   }
   else {
        if (mode=="LSB") {hi=lsbhi;}  // not needed, but as reminder
        if (mode=="USB") {lo=usblo;}
   }
   updbw()
   // end

}

function setautonotch(a)
{
   a=Number(a);
   soundapplet.setparam("autonotch="+a);
}
function setautonotch2(a)
{
   a=Number(a);
   soundapplet.setparam2(a);
}

// DNR MOD
function setnoise(a)
{
   a=Number(a);
   soundapplet.setnoise(a);
}
//end DNR
function setnoisereduction(level)
// level -999 means off
{
   a=Number(level);
   soundapplet.setparam("noisered="+a);
}
function sethboost(a)
{
   a=Number(a);
   soundapplet.sethboost(a);
}

function setmute(a)
{
   a=Number(a);
   soundapplet.setparam("mute="+a);
}

function draw_passband()
{
   passbandobjstart=Math.round((lo-0.045)/khzperpixel);
   passbandobjwidth=Math.round((hi+0.045)/khzperpixel)-passbandobjstart;
   if (passbandobjwidth == 0) passbandobjwidth = 1;
   passbandobj.style.width=passbandobjwidth+"px";
   if (!scaleobj) return;

   var x=(freq-centerfreq)/khzperpixel+512;
   var maxx = parseInt(scaleobj.style.width);
   if (isTouchDev && x > maxx) x = maxx;
   var y=scaleobj.offsetTop+15;
   passbandobj.style.top=y+"px";
   edgelowerobj.style.top=y+"px";
   edgeupperobj.style.top=y+"px";
   carrierobj.style.top=y-17+"px";
   carrierobj.style.left=x+"px";
   x=x+passbandobjstart;
   passbandobj.style.left=x+"px";
   edgelowerobj.style.left=(x-11)+"px";
   edgeupperobj.style.left=(x+passbandobjwidth)+"px";
}

function volumedb(vol)
{
  document.getElementById('volumedb').innerHTML=" " + vol + "dB";
}

function rememberpreset()
{
  if(mode==='LSB') {lsblo=lo; lsbhi=hi;} else
  if(mode==='USB') {usblo=lo; usbhi=hi;} else
  if(mode==='AM') {amlo=lo; amhi=hi;} else
  if(mode==='FM') {fmlo=lo; fmhi=hi} else
    {cwlo=lo; cwhi=hi;}
}

function showhides()
{
     if(mode==='LSB') {showrow('lsbpresets','usbpresets','ampresets','fmpresets','cwpresets');} else
     if(mode==='USB') {showrow('usbpresets','lsbpresets','ampresets','fmpresets','cwpresets');} else
     if(mode==='AM') {showrow('ampresets' ,'usbpresets','lsbpresets','fmpresets','cwpresets');} else
     if(mode==='FM') {showrow('fmpresets' ,'usbpresets','lsbpresets','ampresets','cwpresets');} else
       {showrow('cwpresets' ,'usbpresets','lsbpresets','ampresets','fmpresets');}
}

function showrow(visiblerow,h1,h2,h3,h4)
{
  var visiblerow;
  var h1;
  var h2;
  var h3;
  var h4;

  {document.getElementById(visiblerow).style.display = "table-row";}
  {document.getElementById(h1).style.display = "none";}
  {document.getElementById(h2).style.display = "none";}
  {document.getElementById(h3).style.display = "none";}
  {document.getElementById(h4).style.display = "none";}
}

function settings_store()
{
   var s={};
   s.allowkeys=document.viewform.allowkeys.checked;
   s.compactview=document.getElementById('compactviewcheckbox').checked;
   s.volume=document.getElementById('volumecontrol2').value;

   s.band=band;
   s.freq=Math.round(freq * 100) / 100;
   s.mode=mode;
   s.lo=lo;
   s.hi=hi;
   s.hidedx=hidedx;
   s.waterfallheight=waterheight;
   s.background=document.getElementById('background_toggle').checked
   s.divRingOpacity=divRing.style.opacity
   try { localStorage.setItem('settings',JSON.stringify(s)); } catch (e) {};
}

function settings_recall()
{
   var s;
   try { s=JSON.parse(localStorage.getItem('settings')); } catch (e) {  return; };
   if (!s) {
	   document.getElementById('background_toggle').checked = true;
	   background_load();
	   return;
	  }
   document.viewform.allowkeys.checked=s.allowkeys;
   document.getElementById('compactviewcheckbox').checked=s.compactview;
   if (s.divRingOpacity) {
	   divRing.style.opacity=s.divRingOpacity;
	   document.getElementById('magicinput').value=s.divRingOpacity;
   }
   if (s.volume) document.getElementById("volumecontrol2").value=s.volume;
   if (s.volume) volumedb(s.volume);
	if (s.hidedx) {
		sethidedx(s.hidedx); 
		document.getElementById('hidedx').checked=s.hidedx;
	} else  {
		sethidedx(s.hidedx); 
	document.getElementById('hidedx').checked=s.hidedx;
	}
   //if (s.band) {band=s.band; setband(band);}
   //if (s.freq) freq=s.freq;
   //if (s.mode) {mode=s.mode; set_mode(mode);}
   //if (s.lo) lo=s.lo;
   //if (s.hi) hi=s.hi;
   //if (s.gain) document.getElementById("manualgain").value=s.gain;
   //if (s.gain) gaindb(s.gain);
   //if (s.waterfallheight) waterheight=s.waterfallheight;
   if (s.background) {
	   document.getElementById('background_toggle').checked = true;
	   background_load();
   }
   var c=document.getElementsByName('wf-size');
   var i;
   for (i=0;i<c.length;i++)
      if (c[i].value-waterheight>=0) {
         c[i].checked=true;
         break;
      }
}

function set_volume(v)
{
    try { soundapplet.setvolume(Math.pow(10,v/10.)) } catch (e) {};
    settings_store();

}

function set_magic(o)
{
    divRing.style.opacity=o
    settings_store();
}

function iscw()
{
   return hi-lo < 1.4;
}

function nominalfreq()
{
   if (iscw()) return freq+(hi+lo)/2;
   return freq;
}

function freq2x(f,b)
{
   return (f-bi[b].effcenterfreq)*1024/bi[b].effsamplerate+512;
}

function wf_freq_visible(b,f)
{
   if (waitingforwaterfalls>0) return;
   var x = freq2x(f,b);
   return(x>=0 && x<1024);
}

function setwaterfall(b,f)
{
   if (waitingforwaterfalls>0) return;
   var x = freq2x(f,b);
   if (x<0 || x>=1024) wfset_freq(b, bi[b].zoom, f);
}


function dx(freq,mode,text)
{
   dxs.push( { freq:freq, mode:mode, text:text } );
}

function setfreqm(b,f,mo)
{
   setband(b);
   set_mode(mo);
   if (iscw()) f-=(hi+lo)/2;
   setfreq(f);
}

function showdx(b)
{
   var s='';
   if (!hidedx) {
      var mems=memories.slice();
      for (i=0;i<mems.length;i++) mems[i].nr=i;
      mems.sort(function(a,b){return a.nomfreq-b.nomfreq});
      for (i=0;i<dxs.length;i++) {
         var x = freq2x(dxs[i].freq,b);
         var nextx;
         if (x>1024) break;
         if (i<dxs.length-1) nextx=freq2x(dxs[i+1].freq,b);
         else nextx=1024;
         if (nextx>=1024) nextx=1280;
         if (x<0) continue;
         var fr=dxs[i].freq;
         var mo=dxs[i].mode;
         s+='<div title="" class="statinfo2" style="max-width:'+(nextx-x)+'px;left:'+(x-6)+'px;top:'+(44-scaleheight)+'px;">';
         s+='<div class="statinfo1"><div class="statinfo0" onclick="setfreqm(b,'+fr+','+"'"+mo+"'"+');">'+dxs[i].text+'<\/div><\/div><\/div>';
         s+='<div title="" class="statinfol" style="width:1px;height:44px;position:absolute;left:'+x+'px;top:-'+scaleheight+'px;"><\/div>';
      }
      for (i=0;i<mems.length;i++) if (mems[i].band==b) {
         var x=freq2x(mems[i].nomfreq,b);
         var nextx;
         if (x>1024) break;
         if (i<mems.length-1) nextx=freq2x(mems[i+1].nomfreq,b);
         else nextx=1024;
         if (nextx>=1024) nextx=1280;
         if (x<0) continue;
         var fr=mems[i].freq;
         var mo=mems[i].mode;
         s+='<div title="" class="statinfo2l" style="max-width:'+(nextx-x)+'px;left:'+(x-6)+'px;top:'+(64-scaleheight)+'px;">';
         var l=mems[i].label;
         if (!l || l=='') l='mem '+mems[i].nr;
         s+='<div class="statinfo1l"><div class="statinfo0l" onclick="setfreqm(b,'+fr+','+"'"+mo+"'"+');">'+l+'<\/div><\/div><\/div>';
         s+='<div title="" class="statinfoll" style="width:1px;height:64px;position:absolute;left:'+x+'px;top:-'+scaleheight+'px;"><\/div>';
      }
   }
   document.getElementById('blackbar'+band2id(b)).innerHTML=s;
   if (s!='') {
      document.getElementById('blackbar'+band2id(b)).style.height='64px';
   } else {
      document.getElementById('blackbar'+band2id(b)).style.height='30px';
   }
   draw_passband();
}

function fetchdx(b)
{
  var xmlHttp;
  try { xmlHttp=new XMLHttpRequest(); }
    catch (e) { try { xmlHttp=new ActiveXObject("Msxml2.XMLHTTP"); }
      catch (e) { try { xmlHttp=new ActiveXObject("Microsoft.XMLHTTP"); }
        catch (e) { alert("Your browser does not support AJAX!"); return false; } } }
  xmlHttp.onreadystatechange=function()
    {
    if(xmlHttp.readyState==4)
      {
        if (xmlHttp.responseText!=""||memories.slice()) {
          eval(xmlHttp.responseText);
          showdx(b);
        }
      }
    }
  var url="/~~fetchdx?min="+(bi[b].effcenterfreq-bi[b].effsamplerate/2)+"&max="+(bi[b].effcenterfreq+bi[b].effsamplerate/2);
  xmlHttp.open("GET",url,true);
  xmlHttp.send(null);
}

function setscaleimgs(b,id)
{
   var e=bi[b];
   var st=e.start>>(e.maxzoom-e.zoom);
   if (st<0) scaleimgs0[id].src="scaleblack.png";
   else scaleimgs0[id].src = e.scaleimgs[e.zoom][st>>10];
   if (e.scaleimgs[e.zoom][1+(st>>10)]) scaleimgs1[id].src = e.scaleimgs[e.zoom][1+(st>>10)];
   else scaleimgs1[id].src="scaleblack.png";
   st+=1024;
   scaleimgs0[id].style.left = (-(st%1024))+"px";
   scaleimgs1[id].style.left = (1024-(st%1024))+"px";
}


function zoomchange(id,zoom,start)
{
   var b=id2band(id);
   var e=bi[b];
   var oldzoom=e.zoom;
   e.effsamplerate = e.samplerate/(1<<zoom);
   e.effcenterfreq = e.centerfreq - e.samplerate/2 + (start*(e.samplerate/(1<<e.maxzoom))/1024) + e.effsamplerate/2;
   e.zoom=zoom;
   e.start=start;
   setscaleimgs(b,id);
   if (b==band) {
      khzperpixel = bi[band].effsamplerate/1024;
      centerfreq = bi[band].effcenterfreq;
      updbw();
   }
   if (!hidedx) {
      clearTimeout(band_fetchdxtimer[b]);
      if (zoom!=oldzoom) {
         dxs=[]; document.getElementById('blackbar'+id).innerHTML=""; 
         fetchdx(b);
	 showdx(b);
      } else {
            showdx(b);
            band_fetchdxtimer[b] = setTimeout('dxs=[]; fetchdx('+b+');',400);
      }
   }
}

var dont_update_textual_frequency=false;

function setstep()
{
  if (document.getElementsByName("step")[5].checked) {tune_step=5} else  //gives 10kHz tune increments
  if (document.getElementsByName("step")[4].checked) {tune_step=4} else  //gives  1kHz tune increments
  if (document.getElementsByName("step")[3].checked) {tune_step=3} else  //gives 500Hz tune increments
  if (document.getElementsByName("step")[2].checked) {tune_step=2} else  //gives 100Hz tune increments
  if (document.getElementsByName("step")[1].checked) {tune_step=1} else  //gives  50Hz tune increments
  if (document.getElementsByName("step")[0].checked) {tune_step=0};      //no rounding if step turned off
}

function setfreq(f)
{
   try { clearTimeout(setfreqif_fut_timer); } catch (e) {} ;
   freq=f;
   document.getElementById("dummyforie").style.display = 'none'; document.getElementById("dummyforie").style.display = 'block';  // utter nonsense, but forces IE8 to update the screen :(
   send_soundsettings_to_server();
   if (view!=Views.blind) draw_passband();
   if (dont_update_textual_frequency) return;
   var nomfreq=nominalfreq();
   if (freq.toFixed) document.freqform.frequency.value=nomfreq.toFixed(2);
   else document.freqform.frequency.value=nomfreq+" kHz";
}

function setfreqif_fut(str)
// called when typing in the frequency field; schedules a frequency update in the future, in case no more key presses follow soon
{
   try { clearTimeout(setfreqif_fut_timer); } catch (e) {} ;
   setfreqif_fut_timer = setTimeout('setfreqif('+str+')',10);
}

function pushButton(mode, lo, hi)
{ mode = mode.toLowerCase()
  try {
    document.querySelectorAll('.btnBandW').forEach(function (e) {e.classList.remove('btn-selected');})
    command = "setmf('"+mode+"', "+lo+', '+hi+");  rememberpreset();";
    document.querySelector(`[onclick="${command}"]`).classList.add('btn-selected')
  } catch(e) {};
}

function setmf(m, l, h)  
{
   mode=m.toUpperCase();
   lo=l;
   hi=h;
   updbw();
   document.getElementById("displaymode").innerHTML=mode;
}

function set_mode(m)    
{
   switch (m.toUpperCase()) {
      case "USB":     setmf("usb",   usblo, usbhi ); showhides(); break;
      case "USBN":    setmf("usb",   usbnlo,usbnhi); showhides(); break;
      case "USBW":    setmf("usb",   usbwlo,usbwhi); showhides(); break;
      case "LSB":     setmf("lsb",   lsblo, lsbhi ); showhides(); break;
      case "LSBN":    setmf("lsb",   lsbnlo,lsbnlo); showhides(); break;
      case "LSBW":    setmf("lsb",   lsbwlo,lsbwhi); showhides(); break;
      case "AM":      setmf("am",    amlo   ,amhi ); showhides(); break;
      case "AMN":     setmf("am",    amnlo  ,amnhi); showhides(); break;
      case "AMW":     setmf("am",    amwlo  ,amwhi); showhides(); break;
      case "AMSYNC":  setmf("amsync",amwlo  ,amwhi); showhides(); break;
      case "CW":      setmf("cw",    cwlo   ,cwhi ); showhides(); break;
      case "CWN":     setmf("cw",    cwnlo  ,cwnhi); showhides(); break;
      case "CWW":     setmf("cw",    cwwlo  ,cwwhi); showhides(); break;
      case "FM":      setmf("fm",    fmlo   ,fmhi ); showhides(); break;
      case "FMN":     setmf("fm",    fmnlo  ,fmnhi); showhides(); break;
      case "FMW":     setmf("fm",    fmwlo  ,fmwhi); showhides(); break;
   }
}

function freqstep(st)
// do a frequency step, suitable for the current mode
// sign of st indicates direction
// magnitude of st is 1, 2 or 3 for small, medium, or large step, with large being one "channel" (where applicable)
{
   var f=nominalfreq();
   var wfvis=wf_freq_visible(band,f);

   if (st == "9") {
      if(mode=="CW") {
         f = Math.round(f);
         setfreq(f-(hi+lo)/2);
      }
      else  {
         f = Math.round(f);
         setfreq(f);
      }
   }
   else {

   var minstep=bandinfo[band].tuningstep;
   if (minstep<0.02) minstep=0.01;
   var steps_ssb= [0.01, 0.5, 1];
   var steps_am5= [0.1, 1, 5];
   // MW channel step (the large step in AM below 1620 kHz): mwStepKHz in sv1btl/station.js,
   // 9 kHz when not set (Europe, Africa, Asia); 10 kHz in the Americas
   var mwstep = (window.STATION && Number(window.STATION.mwStepKHz)) || 9;
   var steps_am9= [0.1, 1, mwstep];
   var steps_fm= [1, 5, 12.5 ];
   var steps=steps_ssb;
   var grid=true;
   var i=Math.abs(st)-1;
if (mode=="AM") {
      if (freq<1620) steps=steps_am9; else steps=steps_am5;
      if (i>=1) grid=true;
   //if (mode=="AM" || mode=="AMSYNC" || mode=="AMCOSTAS") {
      //if (freq>1800) steps=steps_am5;
     // else {
        // if (mw9kHzsteps) steps=steps_am9;
        // else steps=steps_am10;
      
   }
   if (mode=="FM") {
      steps=steps_fm;
   }
   var d=steps[i];
   var f=(st>0)?f:-f;
   if (!grid) f=f+d;
   else {
      var f0=f;
      f=d*Math.ceil(f/d+0.1);
      if (steps==steps_am9 && mwstep==9)
         if (f==180) f=183;  // Europe1 is not on a nice 9 kHz multiple
         else if (f==-180) if (f0<-183) f=-183; else f=-171;
   }
   f=(st>0)?f:-f;
   if (iscw()) f-=(hi+lo)/2;
   setfreq(f);
   if (wfvis) setwaterfall(band,f);
   }
}

// limit frequency when tuning to current band - KA7OEI 20180222
function setfreq_lim(f)
{
    // Prevent from tuning out of currently-set band - KA7OEI 20180220 
    if(f >(bandinfo[band].centerfreq + (bandinfo[band].samplerate/2) + bandinfo[band].maxlinbw))
	f = bandinfo[band].centerfreq + (bandinfo[band].samplerate/2) + bandinfo[band].maxlinbw;
    else if(f <(bandinfo[band].centerfreq - (bandinfo[band].samplerate/2) - bandinfo[band].maxlinbw))
	f = bandinfo[band].centerfreq - (bandinfo[band].samplerate/2) - bandinfo[band].maxlinbw;
    //
    // prevent negative frequency from being set - KA7OEI 20180220
    if(f<0) f = 0;
    //
    setfreq(f);
}

function setfreqtune(s)
{
   var param = new RegExp("([0-9.]*)([^&#]*)").exec(s);
   if (!param[1]) return;
   if (param[2]) set_mode(param[2]);
   setfreqif(param[1]);
}

//----------------------------------------------------------------------------------------
// handling of the memories

var memories_backup=[];

function mem_save()
{
   try { localStorage.setItem('memories',JSON.stringify(memories)); } catch (e) {};
}

var mem_hilite=-1;
var ab_mem_hilite=-1;

function mem_recall(i)
{
   setband(memories[i].band);
   mode=memories[i].mode;
   lo=memories[i].lo;
   hi=memories[i].hi;
   setfreqb0(memories[i].freq);
   updbw();
   setfreq(memories[i].freq);
   setwaterfall(band,memories[i].freq);

   document.getElementById("displaymode").innerHTML=mode.toUpperCase();

   showhides();
}

function mem_erase(i)
{
   var b=memories[i].band;
   memories.splice(i,1);
   mem_show();
   showdx(b);
   try { localStorage.setItem('memories',JSON.stringify(memories)); } catch (e) {};
}

function mem_store(i)
{
   var nomf=nominalfreq();
   var l;
   try { l=memories[i].label;} catch(e){ l=''; };
   memories[i]={freq:freq, nomfreq:nomf, band:band, mode:mode, lo:lo, hi:hi, label:l };
   mem_show();
   showdx(memories[i].band);

   try { localStorage.setItem('memories',JSON.stringify(memories)); } catch (e) {};
}

function mem_label(i,nw)
{
   memories[i].label=nw;
   showdx(memories[i].band);
   try { localStorage.setItem('memories',JSON.stringify(memories)); } catch (e) {};
}

function mem_show()
{
   var i;
   var s="";
   for (i=0;i<memories.length;i++) {
      var m="";
      m=memories[i].mode;
      s+='<tr>';
     // removed class="btnNA" from each line in memory ( <input type="button" class="btnNA" title=")
      s+='<td><input type="button" class="btnMem" title="Update saved frequency" value="Update" style="border-radius: 40px 0px 0px 40px; vertical-align:text-bottom; width:100%;" onclick="mem_store('+i+')"></td>';
	  s+='<td><input type="button" class="btnMem" title="Delete current memory" value="Erase" style="border-radius: 0px 40px 40px 0px; vertical-align:text-bottom; width:100%;" onclick="mem_erase('+i+')"></td>';      
	  s+='<td><center><input type="button" class="btn" style="width: auto; font-weight: bold; font-size: 11px;" title="Listen this frequency" value="'+memories[i].nomfreq.toFixed(2)+'&#13;&#10;KHz '+m+'" onclick="mem_recall('+i+')"></center></td>'; s+='<td><input placeholder="mem '+i+'" title="Label for this memory location" type="text" size=4 onchange="mem_label('+i+',this.value)" value="'+memories[i].label+'"></td>';
      
	  if (memories.length<=2) s+='<td> </td><td> </td>';
      else {
        if (i<memories.length-1) {
          s+='<td><input type="button" class="btn" title="move down" style="font-size: 10px;" value="&#9660;" onclick="mem_down('+i+')"></td>';
        }
        else s+='<td><input type="button" class="btn" title="move down" style="font-size: 10px;" value="&#9660;" onclick="mem_down('+i+')" disabled></td>';
        if (i>0) s+='<td><input type="button" class="btn" title="move up" style="font-size: 10px;" value="&#9650;" onclick="mem_up('+i+')"></td>';
	else s+='<td><input type="button" class="btn" title="move up" style="font-size: 10px;" value="&#9650;" onclick="mem_up('+i+')" disabled></td>';
      }
      s+='</tr>';
   }
   s+='<tr>';
   s+='<td></td>';
   s+='<td></td>';
   s+='<td><center><input type="button" class="btnMem" title="Save current frequency to memory" value="SAVE" onclick="mem_store('+i+')"></center></td>';
   s+='</tr>';
   document.getElementById('memories').innerHTML='<table>'+s+'</table>';
}

function mem_down(i)
{
   var mem_tmp1=memories[i];
   var mem_tmp2=memories[i+1];
   memories[i]=mem_tmp2;
   memories[i+1]=mem_tmp1;
   mem_show();
   mem_save();
   fetchdx(band);
}

function mem_up(i)
{
   var mem_tmp1=memories[i];
   var mem_tmp2=memories[i-1];
   memories[i]=mem_tmp2;
   memories[i-1]=mem_tmp1;
   mem_show();
   mem_save();
   fetchdx(band);
}

var jQuery={};

function load_jquery_csv()
{
   if (jQuery.csv) return;
   var script = document.createElement('script');
   script.src = 'sv1btl/jquery.csv.min.js';
   script.type = 'text/javascript';
   document.body.appendChild(script);
}

function mem_downloadCSV_do(m)
{
   if (!jQuery.csv) { setTimeout(function () { mem_downloadCSV_do(m) },100); return; }
   try {
      var mimetype = 'text/csv';
      var s=jQuery.csv.fromObjects(m);
      var bb = new Blob([s], {type: mimetype});
      var downloadurl = window.URL.createObjectURL(bb);
      var a=document.createElement("a");
      a.style.display = "none";
      a.href=downloadurl;
      a.download="websdr_memories.csv";
      document.body.appendChild(a);
      a.click();
   } catch (e) {
      alert('Not supported on this browser ');
   }
}

function mem_downloadCSV()
{
   var m=[];
   var i,len=memories.length;
   for (i=0;i<len;i++) {
      var e=memories[i];
      if (e.mode=="column") m.push({mode:"-----"});
      else { m.push({ freq:e.nomfreq.toFixed(2), band:e.band, mode:e.mode, label:e.label, lo:e.lo.toFixed(2), hi:e.hi.toFixed(2)}) };
   }
   load_jquery_csv();
   mem_downloadCSV_do(m);
}

function mem_uploadCSV_do(what)
{
   if (!jQuery.csv) { setTimeout(function () { mem_uploadCSV_do(what) },100); return; }
   var fs=document.getElementById('uploadcsvfilebutton'+what).files;
   if (!fs[0]) return;
   var reader = new FileReader();
   reader.onload= function() {
      try {
         var o=jQuery.csv.toObjects(reader.result);
      } catch(e) {
         alert('Not supported on this browser ');
         return;
      };
      var i,len=o.length;
      var er="";
      for (i=0;i<len;i++) {
         var v=o[i];
	 if (!v.mode) { er="Missing 'mode' column"; break; }
	 if (v.mode=="column" || v.mode[0]=='-') { o[i]={ mode:"column" }; continue; };
	 if (!v.freq) { er="Missing 'freq' column"; break; }
	 v.freq=+v.freq;
	 if (!v.label) v.label="";
	 v.nomfreq=v.freq;
	 v.band=+v.band;
	 v.mode=v.mode.toUpperCase();
	 if (v.lo) v.lo=+v.lo;
	 if (v.hi) v.hi=+v.hi;
	 if (!v.lo || !v.hi || (v.lo==0 && v.hi==0)) {
	    if (v.mode=='AM')  { v.lo=amlo; v.hi=amhi; }
            if (v.mode=='FM')  { v.lo=fmlo; v.hi=fmhi; }
            if (v.mode=='LSB') { v.lo=lsblo; v.hi=lsbhi; }
            if (v.mode=='USB') { v.hi=usblo;  v.lo=usbhi; }
            if (v.mode=='CW')  { v.lo=cwlo;   v.hi=cwhi; }
	 }
	 if (v.mode=='CW') v.freq=v.nomfreq-(v.lo+v.hi)/2;
      }
      if (er!="") alert(er);
      else {
         memories_backup=memories;
         if (what==2) memories=o;
         else {
            memories.splice(memories.length-1,1);  // remove empty column marker
            memories=memories.concat(o);
         }
         mem_show();
         mem_save();
      }
   };
   reader.readAsText(fs[0]);
}

function mem_uploadCSV(what)
{
   load_jquery_csv();
   mem_uploadCSV_do(what);
}

function mem_deleteall()
{
   // SV1BTL: was "if (memories.length<=2) return;", which made Delete all do nothing with
   // one or two memories. Only an empty list is skipped (so a second click cannot
   // overwrite the copy that the undo button brings back).
   if (memories.length==0) return;
   memories_backup=memories;
   memories=[];
   mem_show();
   mem_save();
   showdx(band);   // remove their labels from the frequency scale
}

function mem_revert()
{
   var tmp=memories;
   memories=memories_backup;
   memories_backup=tmp;
   mem_show();
   mem_save();
   showdx(band);
}

function vfos_toggle()
{
   var tmp;
   tmp=ab_lo; ab_lo=lo; lo=tmp;
   tmp=ab_hi; ab_hi=hi; hi=tmp;
   tmp=ab_mode; ab_mode=mode; mode=tmp;
   tmp=ab_band; ab_band=band; band=tmp;
   tmp=ab_freq; ab_freq=freq; freq=tmp;
   tmp=ab_mem_hilite; ab_mem_hilite=mem_hilite;
   setband(band);
   setfreq(freq);
   updbw();
   mem_hilite=tmp;
   if (mem_hilite>=0) document.getElementById('membutton'+mem_hilite).style.backgroundColor='#ffff80';
   setwaterfall(band,freq);

   showhides();
}

function vfos_equal()
{
   ab_lo=lo;
   ab_hi=hi;
   ab_mode=mode;
   ab_band=band;
   ab_freq=freq;
   ab_mem_hilite=mem_hilite;
}

//----------------------------------------------------------------------------------------
// end handling of the memories

function setstep()
{
  if (document.getElementsByName("step")[5].checked) {tune_step=5} else  
  if (document.getElementsByName("step")[4].checked) {tune_step=4} else  
  if (document.getElementsByName("step")[3].checked) {tune_step=3} else  
  if (document.getElementsByName("step")[2].checked) {tune_step=2} else  
  if (document.getElementsByName("step")[1].checked) {tune_step=1} else  
  if (document.getElementsByName("step")[0].checked) {tune_step=0};      
}

function setfreqb0(f)
{
   var e=bi[band];
   if (f>e.centerfreq-e.samplerate/2-4 && f<e.centerfreq+e.samplerate/2+4) {
      setwaterfall(band,f);
      setfreq(f);
      return;
   }
   for (i=0;i<nvbands;i++) {
      e=bi[i];
      c=e.centerfreq;
      w=e.samplerate/2+4;
      if (f>c-w && f<c+w) {
         e.vfo=f;
         setband(i);
         return;
      }
   }
}

function setfreqb(f)
// sets frequency but also autoselects band
{
   if (iscw()) f-=(hi+lo)/2;
   var e=bi[band];
   if (f>e.centerfreq-e.samplerate/2-4 && f<e.centerfreq+e.samplerate/2+4) {
      // new frequency is in the current band
      setwaterfall(band,f);
      setfreq(f);
      if (initmodeflag==1 || mode=="USB") modeperfreq(f);
      initmodeflag=1;
      return;
   }
   // new frequency is not in the current band: then search through all bands until we find the right one (if any)
   for (i=0;i<nvbands;i++) {
      e=bi[i];
      c=e.centerfreq;
      w=e.samplerate/2+4;
      if (f>c-w && f<c+w) {
         e.vfo=f;
         setband(i);
         return;
      } 
   }
}

function setfreqif(str)
{
	str=str.toString()
   f=parseFloat(str);
   if (!(f>0)) return;
   dont_update_textual_frequency=true;
   setfreqb(f);
   dont_update_textual_frequency=false;
   if (str.includes('.')) {
    document.freqform.frequency.value=str;
   } else{
     document.freqform.frequency.value=str+'.00';
   }
}

/* (orifinal) function setfreqif(str)
// called when frequency is entered textually
{
	str= str.toString()
   f=parseFloat(str);
   if (!(f>0)) return;
   dont_update_textual_frequency=true;
   setfreqb(f);
   dont_update_textual_frequency=false;
   if (str.includes('.')) {
	   document.freqform.frequency.value=str;
   } else{
	   document.freqform.frequency.value=str+'.00';
   }
   document.freqform.frequency.blur();
}   */

function freq_step(i)
{
  if (i=="-1") {udkflag=1; tune_old=tune_step; tune_step=0; freqstep(-1); tune_step=tune_old; setstep();}
  if (i=="9") {tune_step=0; freqstep(9); setstep();}
  if (i=="+1") {udkflag=1; tune_old=tune_step; tune_step=0; freqstep(+1); tune_step=tune_old; setstep();}
}

function wfset_freq(b, zoom, f)
{
   var id=band2id(b);
   var e=bi[b];
   var effsamplerate = e.samplerate/(1<<zoom);
   var start = ( f - e.centerfreq + e.samplerate/2 - effsamplerate/2 )*1024/(e.samplerate/(1<<e.maxzoom));
   waterfallapplet[id].setzoom(zoom, start);
   timeout_idle_restart()
}

function wfset(cmd)
{
   var b=band;
   var e=bi[b];
   var id=band2id(b);
   timeout_idle_restart()
   if (cmd==0) {
      var x=512;
      waterfallapplet[id].setzoom(-2, x);
      return;
   }
   if (cmd==1) {
      var x=512;
      waterfallapplet[id].setzoom(-1, x);
      return;
   }
   if (cmd==2) {
      wfset_freq(b, e.maxzoom, freq);
   }
    if (cmd==3) {
      var min,max;
      min=freq-100; max=freq+100
      var center = (max+min)/2;
      var width = max-min;
      var j=0;
      while (2*width<e.samplerate && j<e.maxzoom) { j++; width=width*2; }
      wfset_freq(b, j, center);
      wfset_freq(b+10, j, center);
   }
   
/*      if (cmd==3) {
      // rx to center
      //var x=(freq-centerfreq)/khzperpixel+512;
      var x=512;
//      var x=500;
//      wfset_freq(b, e.zoom, freq);
      wfset_freq(b, e.zoom, freq);
      waterfallapplet[id].setzoom(-2, x);     
//      waterfallapplet[id].setzoom(-1, x);     
   }
   */
   
   if (cmd==4) {
     
	 waterfallapplet[id].setzoom(0, 0);
   }
}

function setview(v)
{
   timeout_idle_restart()
   if ((v==Views.allbands && view==Views.othersslow) || (view==Views.allbands && v==Views.othersslow)) {
      // no need to restart the applets in this case
      view=v;   
      createCookie("view",view,3652);
      waterfallspeed(waterslowness);
      return;
   }

   if (view==Views.blind) {
      var els = document.getElementsByTagName('*');
      for (i=0; i<els.length; i++) {
         if (els[i].className=="hideblind") els[i].style.display="inline";
         if (els[i].className=="showblind") els[i].style.display="none";
      }
   }
   for (i=0;i<nwaterfalls;i++) waterfallapplet[i].destroy();

   view=v;   
   createCookie("view",view,3652);

   document_waterfalls();  // (re)start the waterfall applets

   if (view==Views.blind) {
      var els = document.getElementsByTagName('*');
      for (i=0; i<els.length; i++) {
         if (els[i].className=="showblind") els[i].style.display="inline";
         if (els[i].className=="hideblind") els[i].style.display="none";
      }
      return;
   }
}

function modeperfreq(fff)
{
// by amk For those who compine bands with didderent mode in one (bandplan).
   var ffff=fff;
 if (ffff>10400000.00 && ffff<10500000.00) setmf("usb", usblo, usbhi, watermode=1);
 if (ffff>70005.00 && ffff<450000.00) setmf("fm", fmlo, fmhi, watermode=1);
 if (ffff>29705.00 && ffff<70000.00) setmf("usb", usblo, usbhi, watermode=1);
 if (ffff>=29005.00 && ffff<29700.00) setmf("fm", fmlo, fmhi, watermode=1);
 if (ffff>27410.00 && ffff<29000.00) setmf("usb", usblo, usbhi, watermode=1);
 if (ffff>26965.00 && ffff<27405.00) setmf("fm", fmlo, fmhi, watermode=1);
 if (ffff>26600.00 && ffff<26960.00) setmf("am", amlo, amhi, watermode=1);
 if (ffff>21855.00 && ffff<26590.00) setmf("usb", usblo, usbhi, watermode=1);
 if (ffff>21455.00 && ffff<21850.00) setmf("am", amlo, amhi, watermode=1);
 if (ffff>18005.00 && ffff<21450.00) setmf("usb", usblo, usbhi, watermode=1);
 if (ffff>17405.00 && ffff<17990.00) setmf("am", amlo, amhi, watermode=1);
 if (ffff>16005.00 && ffff<17400.00) setmf("usb", usblo, usbhi, watermode=1);
 if (ffff>15005.00 && ffff<15990.00) setmf("am", amlo, amhi, watermode=1);
 if (ffff>14000.00 && ffff<15000.00) setmf("usb", usblo, usbhi, watermode=1);
 if (ffff>13515.00 && ffff<13995.00) setmf("am", amlo, amhi, watermode=1);
 if (ffff>12125.00 && ffff<13510.00) setmf("usb", usblo, usbhi, watermode=1);
 if (ffff>11505.00 && ffff<12120.00) setmf("am", amlo, amhi, watermode=1);
 if (ffff>9950.00 && ffff<11500.00) setmf("usb", usblo, usbhi, watermode=1);
 if (ffff>9105.00 && ffff<9945.00) setmf("am", amlo, amhi, watermode=1);
 if (ffff>7605.00 && ffff<9100.00) setmf("usb", usblo, usbhi, watermode=1);
 if (ffff>7205.00 && ffff<7605.00) setmf("am", amlo, amhi, watermode=1);
 if (ffff>7000.00 && ffff<7200.00) setmf("lsb", lsblo, lsbhi, watermode=1);
 if (ffff>6780.00 && ffff<6995.00) setmf("usb", usblo, usbhi, watermode=1);
 if (ffff>6625.00 && ffff<6775.00) setmf("lsb", lsblo, lsbhi, watermode=1);
 if (ffff>6205.00 && ffff<6620.00) setmf("usb", usblo, usbhi, watermode=1);
 if (ffff>5805.00 && ffff<6200.00) setmf("am", amlo, amhi, watermode=1);
 if (ffff>5005.00 && ffff<5795.00) setmf("usb", usblo, usbhi, watermode=1);
 if (ffff>4755.00 && ffff<5000.00) setmf("am", amlo, amhi, watermode=1);
 if (ffff>4005.00 && ffff<4750.00) setmf("usb", usblo, usbhi, watermode=1);
 if (ffff>3900.00 && ffff<4000.00) setmf("am", amlo, amhi, watermode=1);
 if (ffff>3305.00 && ffff<3900.00) setmf("lsb", lsblo, lsbhi, watermode=1);
 if (ffff>3005.00 && ffff<3300.00) setmf("am", amlo, amhi, watermode=1);
 if (ffff>2005.00 && ffff<3000.00) setmf("usb", usblo, usbhi, watermode=1);
 if (ffff>1805.00 && ffff<2000.00) setmf("lsb", lsblo, lsbhi, watermode=1);
 if (ffff>1611.00 && ffff<1805.00) setmf("am", amlo, amhi, watermode=1);
 if (ffff>495.00 && ffff<1611.00) setmf("am", amlo, amhi, watermode=1);
 if (ffff>285.00 && ffff<490.00) setmf("usb", usblo, usbhi, watermode=1);
 if (ffff>153.00 && ffff<280.00) setmf("am", amlo, amhi, watermode=1);
 if (ffff>10.00 && ffff<150.00) setmf("usb", usblo, usbhi, watermode=1);
	  
   return;
}

function islsbband(b)
{
   // returns true if default SSB mode for this band should be LSB
/*  var e=bi[b];
    if (e.centerfreq>3500 && e.centerfreq<4000) return 1;
    if (e.centerfreq>1800 && e.centerfreq<2000) return 1;
    if (e.centerfreq>7000 && e.centerfreq<7200) return 1;
*/
   return 0;
}

function setband(b)
{
   if (b<0 || b>=nvbands) return;
   bi[band].vfo=freq;
    var bandamk=band; 
/*   if (islsbband(band)!=islsbband(b)) {
	   // if needed, exchange LSB/USB 
      var tmp=hi;
      hi=-lo;
      lo=-tmp;
      if (mode=="USB") {
		  mode="LSB";
		  set_mode('lsb');
	  } else if (mode=="LSB") {
		  mode="USB";
		  set_mode('usb')
	  }
   }
   */

   band=b;
   var e=bi[b];
   if (nbands>1) document.freqform.group0[band].checked=true;
   if (view==Views.allbands || view==Views.othersslow) {
      scaleobj = scaleobjs[b];
   } else if (view==Views.oneband) {
      scaleobj = scaleobjs[0];
      setscaleimgs(b,0);
      if (waitingforwaterfalls==0) waterfallapplet[0].setband(b, e.maxzoom, e.zoom, e.start);
      if (!hidedx) {
         clearTimeout(band_fetchdxtimer[b]);
         dxs=[]; document.getElementById('blackbar0').innerHTML=""; 
         fetchdx(b);
       }
   }
   setwaterfall(b,e.vfo);
   centerfreq = e.effcenterfreq;
   khzperpixel = e.effsamplerate/1024;
   setfreq(e.vfo);
   waterfallspeed(waterslowness);

   if (initmodeflag==1) modeperfreq(freq);
// Updated on-screen indication of currently-selected mode - KA7OEI 20190227   
   document.getElementById("displaymode").innerHTML=mode;
   try {
      document.getElementById('btnB-'+band).classList.add('btn-selected');
      var ar=['0','1','2','3','4','5','6','7'];
      for (var i=0;i<ar.length;i++) if (ar[i]!=band) document.getElementById('btnB-'+ar[i]).classList.remove('btn-selected');
   } catch(e) {};
   setTimeout(' smetermintimer=0',1000)
   // SV2YJ - setting the mode so the HTML controls for the correct mode are visible.
   set_mode(mode);
}

function sessionTime()
{
  occloop = setInterval(function() 
  {
    samplecount = samplecount + 1;
    windowsecs = parseInt(samplecount % 60);
    windowhours = parseInt(samplecount / 3600);
    windowmins = parseInt((samplecount % 3600) / 60);
    }, 1000); 
}
function timeout_idle_do()
{
   try { clearInterval(interval_updatesmeter); } catch (e) {} ;
   try { clearTimeout(interval_ajax3); } catch (e) {} ;
   var i;
   try { for (i=0;i<nwaterfalls;i++) waterfallapplet[i].destroy(); } catch (e) {} ;
   try { soundapplet.destroy(); } catch (e) {};

  if (document.usernameform.username.value == "1")
  {
    idletimeout=0;
  }
     if (idletimeout > 59999) {idle_sub_text = idletimeout/60000 + " min.";}
   else if (idletimeout < 60000) {idle_sub_text = idletimeout/1000 + " sec.";}

   idle_page='<div>';
     idle_page+='<div style="margin-bottom: 20px; background-color: #fff; border: 1px solid transparent; border-radius: 4px;">';
       idle_page+='<div style="padding: 25px;">';
         idle_page+='<div style="color: #ffffff; background-color: #ff0000; border-color: #ff0000; padding: 15px; border: 1px solid transparent; border-radius: 4px; text-align: center;" role="alert">';
           idle_page+='<span style="text-align: center; font-size: 24px;"><b>You are inactive.</b></span><br>';
           idle_page+='<span style="text-align: center; font-size: 18px;"><b>Time limit: '+ idle_sub_text +'</b></span>';
         idle_page+='</div>';
         idle_page+='<div style="margin-top: 25px; text-align: center;">';
           idle_page+='<button type="button" style="font-family: inherit; color: black; display: inline-block; padding: 8px; cursor: pointer; font-size: 16px;" onClick="window.location.reload()">Reload WebSDR page</button>';
         idle_page+='</div>';
       idle_page+='</div>';
     idle_page+='</div>';
   idle_page+='</div>';

   document.body.innerHTML=idle_page;
}

function timeout_idle_restart()
{
  if (document.usernameform.username.value == "161NS001")
  {
    idletimeout=0;
  }

   if (!idletimeout) return;
   time_out = (idletimeout / 1000) / 60;
   timeout_secs = samplecount;
   try { clearTimeout(timeout_idle); } catch(e) {};
   timeout_idle=setTimeout('timeout_idle_do();',idletimeout);
}

function sethidedx(h)
{
   hidedx=h;
   if (view==Views.oneband) {
      if (hidedx) {
         dxs=[]; document.getElementById('blackbar0').innerHTML=""; 
         clearTimeout(band_fetchdxtimer[band]);
         document.getElementById('blackbar0').style.height='30px';
      } else {
         showdx(band);
         fetchdx(band);
      }
   } else {
      for (b=0;b<nvbands;b++) {
         if (hidedx) {
            dxs=[]; document.getElementById('blackbar'+band2id(b)).innerHTML=""; 
            clearTimeout(band_fetchdxtimer[b]);
            document.getElementById('blackbar'+band2id(b)).style.height='30px';
			draw_passband();
         } else {
            showdx(b);
            fetchdx(b);
         }
      }
   }
}

function test_serverbusy()
{
   try { soundapplet.app.l=1; } catch (e) {};
   try { serveravailable=soundapplet.getid(); } catch (e) {};
   if (serveravailable==0) {
      try { clearInterval(interval_updatesmeter); } catch (e) {} ;
      try { clearTimeout(interval_ajax3); } catch (e) {} ;
      var i;
      try { for (i=0;i<nwaterfalls;i++) waterfallapplet[i].destroy(); } catch (e) {} ;
      try { soundapplet.destroy(); } catch (e) {};
      document.body.innerHTML="Sorry, the WebSDR server is too busy right now; please try again later.\n";
   }
}

var sgraph={
   prevt: 0,
   e0: 80,     
   e1: -190,  
   d0: 80,     
   d1: -190,  
   width: 200,
   cnt: 0
};

function s2y(s)
{
   return sgraph.cv.height-(s-sgraph.e0)/(sgraph.e1-sgraph.e0)*sgraph.cv.height;
}

function round(value, step) {
    step || (step = 1.0);
    var inv = 1.0 / step;
    return Math.round(value * inv) / inv;
}

function updatesmeter()
{
   if (!allloadeddone) return;

   try {
      var s=soundapplet.smeter();
   
   	// Offset of S-meter on a per-band basis (values at top of file) to allow waterfall brightness adjustment - KA7OEI 20180313
	if(band==0) s=s+band0_smeter_offset;
	else if(band==1) s=s+band1_smeter_offset;
	else if(band==2) s=s+band2_smeter_offset;
	else if(band==3) s=s+band3_smeter_offset;
	else if(band==4) s=s+band4_smeter_offset;
	else if(band==5) s=s+band5_smeter_offset;
	else if(band==6) s=s+band6_smeter_offset;
	else if(band==7) s=s+band7_smeter_offset;
	   
   } 
	catch (e) { s=0; };
 
   if (s>=0) {
	   block_width = document.getElementsByClassName('smetertable')[0].rows[0].cells[0].getBoundingClientRect().width
	   smeterobj.style.width= s*0.0191667*1.08+"px";
	   blocks = Math.round(s*0.0191667*1.08/block_width);
	   smeterobjnew.style.width= block_width*blocks +"px";
   }
 
   else smeterobj.style.width="0px";
   smeterpeaktimer--;
   if ((smeterpeak<s-0.1) || (smeterpeaktimer<=0)) {
      smeterpeak=s;
      smeterpeaktimer=10;
	  
      if (smeterpeak >= 0) {
            new_width = smeterpeak * 0.0191667 *1.08
            if (parseFloat(smeterpeakobj.style.width)-new_width > 0) smeterpeakobj.style.transition = '0.3s width'
            else smeterpeakobj.style.transition = '0.1s width'
            smeterpeakobj.style.width = new_width + "px";
            }
      else smeterpeakobj.style.width="0px";
      var c=''+(s/100.0-127).toFixed(1); sig=Number(c);
   }
	
	smetermintimer--;
	if ((smetermin>s-100) || (smetermintimer<=0))    //original ((smetermin>s-100) || (smetermintimer<=0)) - loops to find signal min during sampling window, stops when time-up.
		{
		smetermin=s;  // original smetermin=s; - remembers current Npeak to see if next sample is lower
		if (s==0) smetermintimer=1;else 			  //original smetermintimer= - ensures sampling resumes quickly after a zero sig event
		{ if (mode=="CW")	{smetermintimer=20;}else  //if OOK,frequently update noise - between dits
		  if (mode=="AM")	{smetermintimer=200;}else //original smetermintimer=200 - if AM, infrequent updates to retain earlier min. Stops carrier being interpreted as noise giving erroneous SNR=0
		  if (mode=="FM") {smetermintimer=200;}else
				  {smetermintimer=200;} // original smetermintimer=600 - here if SSB, update noise during pauses in speech (if too long, N becomes equal to Sig)
		}

		if (smetermin>=0) {
          new_width = smetermin * 0.0191667
          if (parseFloat(smeterminobj.style.width)-new_width < 0) smeterminobj.style.transition = '10s width'
          else smeterminobj.style.transition = '0.1s width'
          smeterminobj.style.width = new_width + "px";
          smeterminobj.style.width= (smetermin*0.0191667)*1.08 +"px";
		} 
		else smeterminobj.style.width="0px";
		}
	snrValue=Math.round((smeterpeak-smetermin)/100)
	snrobj.textContent = snrValue
	// MagicEye
    if (s/61-77.3<0) {eyeval=0;
        } else {eyeval=s/61-77.3}
    if (eyeval<60) {setProgress(eyeval/0.8);
        } else {setProgress(34+eyeval/3)}
	// MagicEye Old SNR)
/*	if (snrValue<45) {
		setProgress(snrValue/0.8);
	} else {		setProgress(45/0.8)}
*/	
   if (serveravailable<0) test_serverbusy();


   // rest of this function is for drawing the signal strength plot

   var v=document.getElementById('sgraphchoice').value;
   var v2=v;
   if(v>10)
	v=v-10;
   if (!(v>0)) {
      if (sgraph.cv) {
         sgraph.ct.clearRect(0,0,sgraph.cv.width, sgraph.cv.height);
         sgraph.cv.style.display='none';
         sgraph.cv=null;
         sgraph.e0=80;
         sgraph.e1=-190;
      }
      return;
   }

   if (!sgraph.cv) {
      sgraph.cv=document.getElementById('sgraph');
      sgraph.cv.style.display='';
      sgraph.ct=sgraph.cv.getContext("2d");
   }
   var cv=sgraph.cv;
   var ct=sgraph.ct;
   sgraph.width=cv.width-50;

   if(v2<=10)
      s=s/100.0-127;
   else
      s=smeterpeak/100.0-127;
	  

   //
   // try to estimate the useful range of values, without storing all datapoints, and rescale the plot if needed
   if (sgraph.d0>s) sgraph.d0=s; else sgraph.d0+=0.1/v;
   if (sgraph.d1<s) sgraph.d1=s; else sgraph.d1-=0.1/v;
   var redrawaxis=0;
   if (sgraph.d0>sgraph.e0+15 || sgraph.d0<sgraph.e0) { 
      var e0=10*Math.floor(sgraph.d0/10)-5;
      if (e0>sgraph.e0) ct.drawImage(cv, 0,0, sgraph.width,cv.height*(sgraph.e1-e0)/(sgraph.e1-sgraph.e0), 0,0,sgraph.width,cv.height);
      else {
         var f=(sgraph.e1-sgraph.e0)/(sgraph.e1-e0);
         ct.drawImage(cv, 0,0, sgraph.width,cv.height, 0,0,sgraph.width,cv.height*f);
         ct.fillStyle="white";
         ct.fillRect(0,Math.floor(cv.height*f),sgraph.width,cv.height*(1-f)+1);
      }
      sgraph.e0=e0;
      redrawaxis=1;
   }
   if (sgraph.d1>sgraph.e1 || sgraph.d1<sgraph.e1-15) {
      var e1=10*Math.ceil(sgraph.d1/10)+5;
      if (e1<sgraph.e1) {
         var f=(e1-sgraph.e0)/(sgraph.e1-sgraph.e0);
         if (f<0) f=0;
         ct.drawImage(cv, 0,cv.height*(1-f), sgraph.width,cv.height*f, 0,0,sgraph.width,cv.height);
      } else {
         var f=(sgraph.e1-sgraph.e0)/(e1-sgraph.e0);
         if (f<0) f=0;
         ct.drawImage(cv, 0,0, sgraph.width,cv.height, 0,cv.height*(1-f),sgraph.width,cv.height*f);
         ct.fillStyle="white";
         ct.fillRect(0,0,sgraph.width,Math.ceil(cv.height*(1-f)));
      }
      sgraph.e1=e1;
      redrawaxis=1;
   }
   if (redrawaxis) {
      ct.clearRect(sgraph.width,0,cv.width-sgraph.width,cv.height);
      var w=sgraph.e0;
      ct.fillStyle="black";
      ct.font="10px Verdana";
      while ((w=10*Math.ceil(w/10))<=sgraph.e1) {
         var y=s2y(w);
         ct.fillText(w+" dB",sgraph.width+2,y+4,cv.width-sgraph.width);
         w+=1;
      }
   }

   sgraph.cnt++;
   if (sgraph.cnt>=v) {
      sgraph.cnt=0;
      ct.drawImage(cv, 1,0,sgraph.width-1,cv.height, 0,0,sgraph.width-1,cv.height);  // move the plot one pixel to the left
      var t=new Date().getTime();
      if (v>=10) v=60;
      if (Math.floor(t/1000/v)!=Math.floor(sgraph.prevt/1000/v)) {
         // draw grey vertical line as time marker
         ct.fillStyle="rgba(210,210,210,1)";
         ct.fillRect(sgraph.width-1,0,1,cv.height);
         sgraph.prevt=t;
      } else {
         // draw white vertical line with grey dB scale markers
         ct.fillStyle="white";
         ct.fillRect(sgraph.width-1,0,1,cv.height);
         ct.fillStyle="rgba(210,210,210,1)";
         var w=sgraph.e0;
         while ((w=10*Math.ceil(w/10))<=sgraph.e1) {
            var y=s2y(w);
            ct.fillRect(sgraph.width-1,y,1,1);
            w+=1;
         }
      }
   }

   // plot the actual data point
   ct.fillStyle="blue";
   ct.fillRect(sgraph.width-1,s2y(s),1,1);
}

function getnoise()
{
	try {
     	var n=soundapplet.smeter();	
    	    } catch (e) { n=0; };

	smetermintimer--;
   	if ((smetermin>n-0.1) || (smetermintimer<=0)) 
    	{
		smetermin=n;
		if (n==0) smetermintimer=2;else 	
		{	if (mode=="CW")	{smetermintimer=20;}else 
			if (mode=="AM")	{smetermintimer=100;}else 
            if (mode=="FM") {smetermintimer=100;}else
					{smetermintimer=40;}
		}

		if (smetermin>=0) smeterminobj.style.width= (smetermin*0.0191667)*1.09 +"px";
		else smeterminobj.style.width="0px";
		}
}

var uu_names=new Array();
var uu_bands=new Array();
var uu_freqs=new Array();
var others_colours=[ "#ff4040", "#ffa000", "#a0a000", "#80ff00", "#00ff00", "#00a0a0", "#0080ff", "#ff40ff"];

var dxs=[];

function uu(i, username, band, freq)
{
   uu_names[i]=username;
   uu_bands[i]=band;
   uu_freqs[i]=freq;
}

var uu_compactview=false;
function douu()
// draw the diagram that shows the other listeners
{
   s='';
   var uw=window.ubersdr_width||1024;   // UberSDR: strip width, matched to the controls panel
   total=0;
   var shifting=1;
   for (b=0;b<nbands;b++) {
      if (!uu_compactview) {
         s+="<p><div  style='width:"+uw+"px; background-color:black;border-radius: 4px;box-shadow: 4px 4px 15px 0px rgba(0,0,0);margin: 0px 5px 0px 5px;margin-left: auto;margin-right: auto;'><div class=others>";
         for (i=0;i<uu_names.length;i++) if (uu_bands[i]==b && uu_names[i]!="") {
            cbandfreq=bandinfo[b].centerfreq-(bandinfo[b].samplerate/2)-shifting*(hi+lo)/2;
	    if (uu_names[i]=="(WebSDR)") {
              s+='<div id="user'+i+'" align="center" style="position:relative;left:'+(uu_freqs[i]*uw-250)+'px;width:500px; color:#ff3333;">';
              s+='<button type="button" class="userbtn" onclick="setfreqb('+(uu_freqs[i]*bandinfo[b].samplerate+cbandfreq).toFixed(2)+');" title="Operator" style="cursor: pointer;margin:0; padding:0 5px; color:#ff3333;">'+uu_names[i]+'</button>';
              s+='</div>';
              total++;
 	    }
	    else {
              s+='<div id="user'+i+'" align="center" style="position:relative;left:'+(uu_freqs[i]*uw-250)+'px;width:500px; color:'+others_colours[i%8]+';">';
              s+='<button type="button" class="userbtn" onclick="setfreqb('+(uu_freqs[i]*bandinfo[b].samplerate+cbandfreq).toFixed(2)+');" style="cursor: pointer;margin:0; padding:0 5px; color:'+others_colours[i%8]+';">'+uu_names[i]+'</button>';
              s+='</div>';
              total++;
            }
         }
         s+="<img src="+bi[b].scaleimgs[0][0]+" style='width:"+uw+"px;height:14px'></div></div></p>";
      } else {
         s+="<p><div style='width:"+uw+"px;height:35px;position:relative; background-color:black;border-radius: 4px;box-shadow: 4px 4px 15px 0px rgba(0,0,0);margin: 0px 5px 0px 5px;margin-left: auto;margin-right: auto;'>";
         for (i=0;i<uu_names.length;i++) if (uu_bands[i]==b && uu_names[i]!="") {
            s+="<div id='user"+i+"' style='position:absolute;top:1px;left:"+
                 (uu_freqs[i]*uw)
                 +"px;width:1px;height:13px; background-color:"+others_colours[i%8]+";'></div>";
            total++;
         }
         s+="<div style='position:absolute;bottom:1px'><img src="+bi[b].scaleimgs[0][0]+" style='width:"+uw+"px;height:14px'></div></div></p>";
      }
   }
   usersobj.innerHTML=s;
   numusers1obj.innerHTML=total;
   numusersobj.innerHTML=total;
}

function setcompactview(c)
{
   uu_compactview=c;
   douu();
}

function ajaxFunction3()
{
  var xmlHttp;
  try { xmlHttp=new XMLHttpRequest(); }
    catch (e) { try { xmlHttp=new ActiveXObject("Msxml2.XMLHTTP"); }
      catch (e) { try { xmlHttp=new ActiveXObject("Microsoft.XMLHTTP"); }
        catch (e) { alert("Your browser does not support AJAX!"); return false; } } }
  xmlHttp.onreadystatechange=function()
    {
    if(xmlHttp.readyState==4)
      {
        if (xmlHttp.status==200 && xmlHttp.responseText!="") {
          eval(xmlHttp.responseText);
          douu();
        }
        clearTimeout(interval_ajax3);
        interval_ajax3 = setTimeout('ajaxFunction3()',1000);
      }
    }
  interval_ajax3 = setTimeout('ajaxFunction3()',120000);
  var url="/~~othersjj?chseq="+chseq;
  xmlHttp.open("GET",url,true);
  xmlHttp.send(null);
}

function javatest()
{
   var javaversion;
   try {
      javaversion = soundapplet.javaversion();
   } catch(err) {
      javaerr=1;
      if (!usejavasound) return;
      document.getElementById("javawarning").style.display= "block";

      javaversion="999";
      setTimeout('javatest()',1000); 
   }
   if (javaversion<"1.4.2") {
      document.getElementById("javawarning").innerHTML='Your Java version is '+javaversion+', which is too old for the WebSDR. Please install version 1.4.2 or newer, e.g. from <a href="http://www.java.com">http://www.java.com</a> if you hear no sound.';
      document.getElementById("javawarning").style.display= "block";
   }
}

  function updbw()
{
   if (lo>hi) {
      if (document.onmousemove == useMouseXYloweredge || touchingLower) lo=hi;
      else hi=lo;
   }
   var maxf=(mode=="FM") ? 15 : (bandinfo[band].maxlinbw*0.95);
   if (lo<-maxf) lo=-maxf;
   if (hi>maxf) hi=maxf;
   
   var xlo=document.getElementById('numericalfilterlow');
   var xhi=document.getElementById('numericalfilterhigh');
   xlo.innerHTML=(lo).toFixed(2);
   xhi.innerHTML=(hi).toFixed(2);

   var x6=document.getElementById('numericalbandwidth6');
   var x60=document.getElementById('numericalbandwidth60');
   x6.innerHTML=(hi-lo+0.091).toFixed(2);
   x60.innerHTML=(hi-lo+0.551).toFixed(2);

   try {
      document.getElementById('btn-'+mode).classList.add('btn-selected');
      var ar=['AM','FM','USB','LSB','CW','AMSYNC','AMCOSTAS','AMN','FMN','USBN','LSBN','CWN'];
      for (var i=0;i<ar.length;i++) if (ar[i]!=mode) document.getElementById('btn-'+ar[i]).classList.remove('btn-selected');
   } catch(e) {};

   setfreq_lim(freq);

   pushButton(mode, lo, hi);
}

// from http://www.quirksmode.org/js/cookies.html
function createCookie(name,value,days) {
	if (days) {
		var date = new Date();
		date.setTime(date.getTime()+(days*24*60*60*1000));
		var expires = "; expires="+date.toGMTString();
	}
	else var expires = "";
	document.cookie = name+"="+value+expires+"; path=/";
}

function readCookie(name) {
	var nameEQ = name + "=";
	var ca = document.cookie.split(';');
	for(var i=0;i < ca.length;i++) {
		var c = ca[i];
		while (c.charAt(0)==' ') c = c.substring(1,c.length);
		if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length,c.length);
	}
	return null;
}

function id2band(id)
{
   if (view == Views.oneband) return band; else return id;
}

function band2id(b)
{
   if (view == Views.oneband) return 0; else return b;
}

//------INSTALL THIS FOR WATERFALL LINES NA5B  
function waterfallspeed(sp)
{
   waterslowness=sp;
   if (waitingforwaterfalls>0) return;
   var done=0;
   if (view==Views.othersslow) {
      for (i=0;i<nwaterfalls;i++)
         if (i==band) waterfallapplet[i].setslow(sp);
         else waterfallapplet[i].setslow(100);
   } else {
      for (i=0;i<nwaterfalls;i++)
         waterfallapplet[i].setslow(sp);
   }
}

function waterfallheight(si)
{
   waterheight=si;
   if (waitingforwaterfalls>0) return;
   for (i=0;i<nwaterfalls;i++) {
      waterfallapplet[i].setSize(1024,si);
   }
   stretch_waterfalls();
   var y=scaleobj.offsetTop+15;
   passbandobj.style.top=y+"px";
   edgelowerobj.style.top=y+"px";
   edgeupperobj.style.top=y+"px";
   carrierobj.style.top=(y-15)+"px";
}
//-----  INSALL END

function waterfallmode(m)
{
   watermode=m;
   if (waitingforwaterfalls>0) return;
   for (i=0;i<nwaterfalls;i++) {
      waterfallapplet[i].setmode(m);
   }
}

function soundappletstarted()
{
   if (usejavasound && javaerr) {
      javaerr=0;
      document.getElementById("javawarning").style.display= "none";
   }
   setTimeout('soundappletstarted2()',100);
}

function soundappletstarted2()
{
   allloadeddone=true;

   soundapplet.setvolume(Math.pow(10, document.getElementById('volumecontrol2').value /10.));

   if (bi[0]) {
      setfreqif(freq);
      updbw();
   }

   try { setmute(document.getElementById('mutecheckbox').checked) } catch(e){};
   try { setsquelch(document.getElementById('squelchcheckbox').checked) } catch(e){};
   try { setautonotch(document.getElementById('autonotchcheckbox').checked) } catch(e){};

   test_serverbusy();
}

function waterfallappletstarted(id)
{
   waitingforwaterfalls--;
   if (waitingforwaterfalls<0) waitingforwaterfalls=0;
   if (waitingforwaterfalls!=0) return;
   setTimeout('allwaterfallappletsstarted()',100);
}

function allwaterfallappletsstarted() 
{
   var i;

   waterfallspeed(waterslowness);
   waterfallmode(watermode);

   for (i=0;i<nwaterfalls;i++) {
      var e=bi[i];
      waterfallapplet[i].setband(e.realband, e.maxzoom, e.zoom, e.start);
   }
   if (view==Views.oneband) {
      var e=bi[band];
      waterfallapplet[0].setband(band, e.maxzoom, e.zoom, e.start);
   }
    for (i=0;i<nwaterfalls;i++) {
     scaleobjs[i] = document.getElementById('clipscale'+i);
     scaleimgs0[i] = document.images["s0cale"+i];
     scaleimgs1[i] = document.images["s1cale"+i];
   }
   if (view==Views.oneband) {
      setscaleimgs(band,0);
      scaleobj = scaleobjs[0];
   } else {
      for (i=0;i<nwaterfalls;i++) setscaleimgs(i,i);
      scaleobj=scaleobjs[band];
   }
   draw_passband();
}

var sup_socket = !!window.WebSocket && !!WebSocket.CLOSING; 
var sup_canvas = !!window.CanvasRenderingContext2D;
var sup_webaudio = window.AudioContext || window.webkitAudioContext;
var sup_mozaudio = false;
try { if (typeof(Audio)==='function' && typeof(new Audio().mozSetup)=='function') sup_mozaudio = true; } catch (e) {};

function html5javawarn()
{ 
   // show warning regarding support for HTML5 or Java if needed
   document.getElementById("javawarning").style.display= (usejavasound && javaerr) ? "block" : "none";
   document.getElementById("html5warning").style.display= (!usejavasound && !sup_webaudio && !sup_mozaudio) ? "block" : "none";
}

function html5orjava(item,usejava)
{
   if (item==0) {
      if (usejavawaterfall==usejava) return;
      usejavawaterfall=usejava;
      var s=(usejavawaterfall?"y":"n")+(usejavasound?"y":"n");
      createCookie("usejava",s,3652);
      var i;
      try { for (i=0;i<nwaterfalls;i++) waterfallapplet[i].destroy(); } catch (e) {} ;
      document_waterfalls();
   }
   if (item==1) {
      if (usejavasound==usejava) return;
      usejavasound=usejava;
      var s=(usejavawaterfall?"y":"n")+(usejavasound?"y":"n");
      createCookie("usejava",s,3652);
      try { soundapplet.destroy(); } catch (e) {};
      document_soundapplet();
      document.getElementById('record_span').style.display= usejavasound ? "none": "inline";
      html5javawarn();
   }
}

function checkjava()
{
   try {
      if (navigator.javaEnabled && navigator.javaEnabled()) return "green";
   } catch(e) {};
   try {
      var m=navigator.mimeTypes;
      for (i=0;i<m.length;i++)
         if (m[i].type.match(/^application\/x-java-applet/)) return "green";
      return "red"; 
   } catch(e) {};
   return "black";
}

function iOS_audio_start()
{
   // Safari on iOS only plays webaudio after it has been started by clicking a button, so this function must be called from a button's onclick handler
   if (!document.ct) document.ct= new webkitAudioContext();
   var s = document.ct.createBufferSource();
   s.connect(document.ct.destination);
   try { s.start(0); } catch(e) { s.noteOn(0); }
}

function set_buffer1(toggle)
{
	if(toggle==1) soundapplet.setdelay1(2000);
       else if(toggle==2) soundapplet.setdelay1(4000);
       else if(toggle==3) soundapplet.setdelay1(8000);
       else if(toggle==4) soundapplet.setdelay1(16000);
       else soundapplet.setdelay1(1000);		// original value
}

function html5orjavamenu()
{
   var s;
   if (sup_webaudio) {
      if (sup_webaudio) {
         if (!document['ct']) document['ct']= new sup_webaudio;
         try {
            var cc=document['ct'].createConvolver;
         } catch (e) {
            document['ct']=null; // firefox 23 supports webaudio, but not yet createConvolver(), making it unusable.
            sup_webaudio=false;
         };
      }
   }
   sup_iOS = 0;   // global!
   sup_android = 0;   // global!
   sup_chrome = 0;  // global!
   sup_firefox = 0;  // global!
   try { 
      var n=navigator.userAgent.toLowerCase();
      if (n.indexOf('iphone')!=-1) sup_iOS=1;
      if (n.indexOf('ipad')!=-1) sup_iOS=1;
      if (n.indexOf('ipod')!=-1) sup_iOS=1;
      if (n.indexOf('ios')!=-1) sup_iOS=1;
      if (n.indexOf('ipados')!=-1) sup_iOS=1;
      if (n.indexOf('macintosh')!=-1) sup_iOS=1;
      if (n.indexOf('android')!=-1) sup_android=1;
      if (n.indexOf('chrome')!=-1) sup_chrome=1;
      if (n.indexOf('firefox')!=-1) sup_firefox=1;
   } catch (e) {};
   if (sup_iOS) isTouchDev=true;
   var usecookie= 'nn';   // UberSDR: HTML5 waterfall and sound only; there is no Java applet
   if (!usecookie) {
      if (sup_socket && sup_canvas) usecookie="n"; else usecookie="y";
      if (sup_socket && (sup_webaudio || sup_mozaudio)) usecookie+="n"; else usecookie+="y";
   }
   usejavawaterfall=(usecookie.substring(0,1)=='y');
   usejavasound=(usecookie.substring(1,2)=='y');
   
   var javacolor=checkjava();
   s='<b>Waterfall:</b>';
   s+='<span style="color: '+javacolor+'"><input type="radio" name="groupw" value="Java" onclick="html5orjava(0,1);"'+(usejavawaterfall?" checked":"")+'>Java</span>';
   if (sup_socket && sup_canvas) s+='<span style="color:green">'; else s+='<span style="color:red">';
   s+='<input type="radio" name="groupw" value="HTML5" onclick="html5orjava(0,0);"'+(!usejavawaterfall?" checked":"")+'>HTML5</span>';
   s+='&nbsp;&nbsp;&nbsp;<b>Sound:</b>';
   s+='<span style="color: '+javacolor+'"><input type="radio" name="groupa" value="Java" onclick="html5orjava(1,1);"'+(usejavasound?" checked":"")+'>Java</span>';
   if (sup_socket && sup_webaudio) s+='<span style="color: green">';
   else if (sup_socket && sup_mozaudio) s+='<span style="color: blue">';
   else s+='<span style="color: red">';
   s+='<input type="radio" name="groupa" value="HTML5" onclick="html5orjava(1,0);"'+(!usejavasound?" checked":"")+'>HTML5</span>';
   if (sup_iOS && sup_socket && sup_webaudio) s+='<input type="button" value="iOS audio start" onclick="iOS_audio_start()">';
   if (document.getElementById('html5choice')) document.getElementById('html5choice').innerHTML = s;
   document.getElementById('record_span').style.display = usejavasound ? "none" : "inline";
}

function registerTouchEvents(id, touchStart, touchMove) {
   var elem=document.getElementById(id);
   elem.addEventListener('touchstart', touchStart);
   elem.addEventListener('touchmove', touchMove);
   elem.addEventListener('touchend', touchEnd);
}

function setusernamecookie() {

   if (document.usernameform.username.value.length > 10 || /\s+/.test(document.usernameform.username.value))
   {
     ip2geo('visited');
     document.usernameform.username.value="";
   }

   createCookie('username',document.usernameform.username.value,365*5);
   var p=document.getElementById("please1");
   if (p) p.innerHTML="Your name or callsign: ";
   p=document.getElementById("please2");
   if (p) p.innerHTML="";
   send_soundsettings_to_server();
}

//----------------------------------------------------------------------------------------
// things related to interaction with the mouse (clicking & dragging on the frequency axes)

var dragging=false;
var dragorigX;
var dragorigval;
var touchingLower=false;

function getMouseXY(e)
{
   e = e || window.event;
   if (e.pageX || e.pageY) return {x:e.pageX, y:e.pageY};
   return {
     x:e.clientX + document.body.scrollLeft - document.body.clientLeft,
     y:e.clientY + document.body.scrollTop  - document.body.clientTop
   };
}

function useMouseXY(e)
{
   var pos=getMouseXY(e);
   var coords = scaleobj.offsetParent.getBoundingClientRect()
   setfreq_lim((pos.x-coords.left-512)*khzperpixel+centerfreq-(hi+lo)/2);
   if (initmodeflag==1) modeperfreq(freq);
   return cancelEvent(e);
}

function touchXY(ev)
{
   ev.preventDefault();
   for (var i=0; i<ev.touches.length; i++) {
      var x = ev.touches[i].pageX;
      setfreq_lim((x-scaleobj.offsetParent.offsetLeft-512)*khzperpixel+centerfreq-(hi+lo)/2);
   if (initmodeflag==1) modeperfreq(freq);
   }
}

function useMouseXYloweredge(e)
{
   var pos=getMouseXY(e);
   lo=dragorigval+(pos.x-dragorigX)*khzperpixel;
   updbw();
   return cancelEvent(e);
}

function touchXYloweredge(ev)
{
   ev.preventDefault();
   for (var i=0; i<ev.touches.length; i++) {
      var x = ev.touches[i].pageX;
      lo=dragorigval+(x-dragorigX)*khzperpixel;
      updbw();
   }
}

function useMouseXYupperedge(e)
{
   var pos=getMouseXY(e);
   hi=dragorigval+(pos.x-dragorigX)*khzperpixel;
   updbw();
   return cancelEvent(e);
}

function touchXYupperedge(ev)
{
   ev.preventDefault();
   for (var i=0; i<ev.touches.length; i++) {
      var x = ev.touches[i].pageX;
      hi=dragorigval+(x-dragorigX)*khzperpixel;
      updbw();
   }
}

function useMouseXYpassband(e)
{
   var pos=getMouseXY(e);
   setfreq_lim(dragorigval+(pos.x-dragorigX)*khzperpixel);
   return cancelEvent(e);
}

function touchXYpassband(ev)
{
   ev.preventDefault();
   for (var i=0; i<ev.touches.length; i++) {
      var x = ev.touches[i].pageX;
      setfreq_lim(dragorigval+(x-dragorigX)*khzperpixel);
   }
}

function mouseup(e)
{
   if (dragging) {
      dragging=false;
      document.onmousemove(e);
      document.onmousemove = null;
   }
}

function touchEnd(ev) {
   ev.preventDefault();
   if (dragging) {
      dragging=false;
      touchingLower=false;
   }
}

function imgmousedown(ev,bb)
{
   var b=id2band(bb);
   dragging=true;
   document.onmousemove = useMouseXY;
   if (view!=Views.oneband && band!=b) {
      if (view==Views.othersslow) waterfallspeed(waterslowness);
      setband(b);
      useMouseXY(ev);
   }
}

function imgtouch(ev) {
   ev.preventDefault();
   
   var e = ev || window.event;
   var img;
   if (e.target) img = e.target; else
   if (e.srcElement) img = e.srcElement;
   if (img.nodeType == 3) img = img.parentNode;
   var bb=0;
   if (img.name) bb = img.name.substring(6,7); else	
   if (img.id) bb = img.id.substring(8,9);

   var b=id2band(bb);
   if (view!=Views.oneband && band!=b) {
      if (view==Views.othersslow) waterfallspeed(waterslowness);
      setband(b);
   }

   if (ev.targetTouches.length == 1) {
      dragging=true;
      dragorigX=ev.targetTouches[0].pageX;
      touchXY(ev);
   }
}

function mousedownlower(ev)
{
   var pos=getMouseXY(ev);
   dragging=true;
   document.onmousemove = useMouseXYloweredge;
   dragorigX=pos.x;
   dragorigval=lo;
   return cancelEvent(ev);
}

function touchlower(ev) {
   ev.preventDefault();
   if (ev.targetTouches.length == 1) {
      touchingLower=true;
      dragging=true;
      dragorigX=ev.targetTouches[0].pageX;
      dragorigval=lo;
   }
}

function mousedownupper(ev)
{
   var pos=getMouseXY(ev);
   dragging=true;
   document.onmousemove = useMouseXYupperedge;
   dragorigX=pos.x;
   dragorigval=hi;
   return cancelEvent(ev);
}

function touchupper(ev) {
   ev.preventDefault();
   if (ev.targetTouches.length == 1) {
      dragging=true;
      dragorigX=ev.targetTouches[0].pageX;
      dragorigval=hi;
   }
}

function mousedownpassband(ev)
{
   var pos=getMouseXY(ev);
   dragging=true;
   document.onmousemove = useMouseXYpassband;
   dragorigX=pos.x;
   dragorigval=freq;
   return cancelEvent(ev);
}

function touchpassband(ev) {
   ev.preventDefault();
   if (ev.targetTouches.length == 1) {
      dragging=true;
      dragorigX=ev.targetTouches[0].pageX;
      dragorigval=freq;
   }
}

function docmousedown(ev)
{
   var fobj;
   if (!ev) fobj=event.srcElement;  // IE
   else fobj = ev.target;  // FF
   if (fobj.className == "scale" || fobj.className=="scaleabs") return cancelEvent(ev);
   return true;
}

var tprevwheel=0;
var prevdir=0;
var wheelstep=1000;

function mousewheel(ev)
{
   var fobj;
   // Win7/IE9 seems to have fixed the problem where 'ev' is null if not called directly, i.e. mousewheel(event)
   if (!ev) {
      ev=window.event; fobj=event.srcElement;	// IE
   }
   else fobj = ev.target;	// FF or IE9

   // In IE and Win7/Chrome the wheel event is not automatically passed on to the Java applet.
   // This check will handle the mouse wheel event for any browser running on Windows (not just IE and Chrome)
   // and hopefully that will not be a problem.
   if (navigator.platform.substring(0,3)=="Win" && fobj.tagName=='APPLET' && fobj.name.substring(0,15)=="waterfallapplet") {
         var pos=getMouseXY(ev);
         var x=pos.x-fobj.offsetParent.offsetLeft;
         // scrollwheel while on the waterfallapplet; only needed in IE/Chrome because FF always passes these events on to the java applet
         if (ev.wheelDelta>0) document[fobj.name].setzoom(-2, x);
         else if (ev.wheelDelta<0) document[fobj.name].setzoom(-1, x);
         event.preventDefault();
         return;
   }

   // this is needed for Mac/Safari and {Mac,Linux,Win7}/Chrome when positioned on the text of a dx label
   if (fobj.nodeType==3) fobj=fobj.parentNode;	// 3=TEXT_NODE, i.e. text inside of a <div>

   if (fobj.className == "scale" || fobj.className=="scaleabs" || fobj.className.substring(0,8) == "statinfo") {
      // this is for tuning using the scroll wheel when positioned on the tuning scale
      var delta = ev.deltaY ? ev.deltaY : ev.detail ? ev.detail : ev.wheelDelta/-40;
      var t=new Date().getTime();
      var dt=t-tprevwheel;
      if (dt<10) dt=1;
      tprevwheel=t;
      prevdir=delta;
      if (Math.abs(delta)<wheelstep && delta!=0) wheelstep=Math.abs(delta);
      delta/=(wheelstep*5);
      if (prevdir*delta>0 && dt<300) delta*=(300./dt);
        if (tune_step==5) {delta=delta/2;} else
	    if (tune_step==4) {delta=delta/2;} else
      	if (tune_step==3) {delta=delta/2;} else
      	if (tune_step==2) {delta=delta/10;} else
        if (tune_step==1) {delta=delta/10;} else
	delta=delta/20;
	setfreq(freq-delta);
      return cancelEvent(ev);
   }

   return true;
}

if (document.addEventListener) {
  window.addEventListener('DOMMouseScroll', mousewheel, false);
   addEventListener('wheel', mousewheel, {passive: false});
// note: "modern" browsers are supposed to use this event, but it seems to be incompatible with the old ones, and for now we'll have t$
//  document.addEventListener('mousewheel', mousewheel, false);
//  document.addEventListener('wheel', mousewheel, false);    // note: "modern" browsers are supposed to use this event, but it seems to be incompatible with the old ones, and for now we'll have to$
  window.addEventListener('mouseup', mouseup, false);
  window.addEventListener('mousedown', docmousedown, false);
} else {
  window.onmousewheel = mousewheel;
  document.onmousewheel = mousewheel;
  document.onmouseup = mouseup;
  document.onmousedown = docmousedown;
}


//----------------------------------------------------------------------------------------
// direct control using keyboard:
var allowkeyboard;

function keydown(e)
{
   if (!document.viewform.allowkeys.checked) return true;
   e = e ? e : window.event;
   if (!e.target) e.target = e.srcElement;
   if (e.target.nodeName=="INPUT" && e.target.type=="text" && e.target.name!="frequency") return true;  // don't intercept keys when typing in one of the text fields, except the frequency field
   var st=1;
   if (e.shiftKey) st=2;
   if (e.ctrlKey || e.altKey || e.metaKey) st=3;
   switch (e.keyCode) {
      case 37:                                                         // left arrow
      case 74: freqstep(-st);                return cancelEvent(e);    // J
      case 39:                                                         // right arrow
      case 75: freqstep(st);                 return cancelEvent(e);    // K
      case 65: setmf ('am',  amlo, amhi);    return cancelEvent(e);    // A
      case 70: setmf ('fm',  fmlo, fmhi);    return cancelEvent(e);    // F
      case 67: setmf ('cw',  cwlo, cwhi);   return cancelEvent(e);     // C
      case 76: setmf('lsb',  lsblo,lsbhi);     return cancelEvent(e);    // L
      case 85: setmf('usb',  usblo,usbhi);     return cancelEvent(e);    // U

	  case 77:   // M = mute
          var mm=!document.getElementById("mutecheckbox").checked;
          document.getElementById("mutecheckbox").checked=mm;
          setmute(mm);
		  toggle_info('mute');
          return cancelEvent(e);  
      case 78: freqstep(9) ;   return cancelEvent(e);                  // =.00
      case 86:   // V/v = volume up/down
          var vv=document.getElementById("volumecontrol2").value;
          if (e.shiftKey) vv++; else vv--;
          document.getElementById("volumecontrol2").value=vv;
		  document.getElementById("volumedb").textContent=vv.toString()+'dB';
          set_volume(vv);
          return cancelEvent(e); 
	case 87:   // w/W = narrower/wider
			  if (e.shiftKey) {
				 if (lo<0) lo*=1.1; else lo/=1.1; if (hi>0) hi*=1.1; else hi/=1.1; updbw();
			  } else {
				 if (lo>0) lo*=1.1; else lo/=1.1; if (hi<0) hi*=1.1; else hi/=1.1; updbw();
			  }
			  return cancelEvent(e);  

      case 90: if (e.shiftKey) wfset(2); else wfset(4); return cancelEvent(e);   // Z
      case 71: document.freqform.frequency.value=""; document.freqform.frequency.focus(); return cancelEvent(e);    // G
      case 66: if (e.shiftKey) setband((band-1+nbands)%nbands);        // B
               else setband((band+1)%nbands);  
               return cancelEvent(e);
   }
   return true;
}

window.onkeydown = keydown;

//----------------------------------------------------------------------------------------
// functions that create part of the HTML GUI

function visit(tmpid) {
  if ( document.getElementById(tmpid).value == '') {
    document.getElementById(tmpid).value = document.getElementById(tmpid).value + " " + geo;
    document.usernameform.username.value = document.getElementById(tmpid).value;
  } else {
    document.getElementById(tmpid).value = document.getElementById(tmpid).value;
    if (document.getElementById(tmpid).value.length > 10 || /\s+/.test(document.getElementById(tmpid).value))
    {
      ip2geo('visited');
      document.getElementById(tmpid).value = document.getElementById(tmpid).value + " " + geo;
    }
    document.usernameform.username.value = document.getElementById(tmpid).value;
  }
}

function newid(tmpid) {
  document.getElementById(tmpid).value = document.getElementById(tmpid).value + " " + geo;
  document.usernameform.username.value = document.getElementById(tmpid).value;
}

function document_username()
{
//  var x= ip2geo('visited');
  var x= readCookie('username');  
  if (x) {
    document.write('<span id="please">Your name or callsign: ');
    document.write('<input type="text" id="visited" name="username" maxlength="11" value="" ondragstart="return false" ondrop="return false" ondrag="return false" onpaste="return false" onblur="visit(this.id); setusernamecookie();" onclick=""></span>');
    

    if (x.length > 10 || /\s+/.test(document.usernameform.username.value))
    {
      ip2geo('visited');
      x="";
    }

    document.addEventListener("keyup", function(event) { event.preventDefault(); if (event.keyCode == 13) {document.getElementById("visited").blur();}});
    document.usernameform.username.value=x;
  } else {
    document.write('<span id="please"><span id="please1"><b><i>Please log in by typing your name or callsign here (it will be saved for later visits in a cookie):&nbsp;&nbsp;&nbsp;&nbsp;<\/i><\/b></span> ');
    document.write('<input type="text" id="time" name="username" maxlength="11" ondragstart="return false" ondrop="return false" ondrag="return false" onpaste="return false" maxlength="20" onfocus=this.value="" onblur="visit(this.id); setusernamecookie();" onclick=""></span>');
    document.addEventListener("keyup", function(event) { event.preventDefault(); if (event.keyCode == 13) {document.getElementById("time").blur();}});
    
    ip2geo('time');
  }
}

function document_waterfalls() 
{
  if (view==Views.allbands || view==Views.othersslow) nwaterfalls=nvbands;
  else if (view==Views.oneband) nwaterfalls=1;
  else { 
     nwaterfalls=0;
     document.getElementById('waterfalls').innerHTML="";
     return;
  }

  var i;
  var b;
  var s="";
  for (i=0;i<nwaterfalls;i++) {
    b = id2band(i);
    e=bi[b];
    j=e.realband;
    s+=
      '<div id="wfdiv'+i+'"></div>'+
      '<div class="scale" style="overflow:hidden; width:1024px; height:'+scaleheight+'px; position:relative" title="click to tune" id="clipscale'+i+'" onmousedown="return false">' +
        '<img src="'+e.scaleimgs[0]+'" onmousedown="imgmousedown(event,'+i+')" class="scaleabs" style="top:0px" name="s0cale'+i+'">' +
        '<img src="'+e.scaleimgs[0]+'" onmousedown="imgmousedown(event,'+i+')" class="scaleabs" style="top:0px" name="s1cale'+i+'">' +
      '</div>' +
      '<div class="scale" style="width:1024px;height:20px;background-color:black;position:relative;" id="blackbar'+i+'" title="click to tune" onmousedown="imgmousedown(event,'+i+')"><\/div>' +
      '\n';
     waterfallapplet[i]={};
     waterfallapplet[i].div='wfdiv'+i;
     waterfallapplet[i].id=i;
     waterfallapplet[i].band=b;
     waterfallapplet[i].maxzoom=bi[b].maxzoom;
  }

  waitingforwaterfalls=nwaterfalls;     // this must be before the next line, to prevent a race
  document.getElementById('waterfalls').innerHTML=s;

  if (usejavawaterfall) {
     if (typeof prep_javawaterfalls =="function") prep_javawaterfalls();
     else {
       script = document.createElement('script');
       script.src = 'websdr-javawaterfall.js';
       script.type = 'text/javascript';
       document.body.appendChild(script);
     }
  } else {
     if (typeof prep_html5waterfalls =="function") prep_html5waterfalls();
     else {
       script = document.createElement('script');
       script.src = 'websdr-waterfall.js';
       script.type = 'text/javascript';
       document.body.appendChild(script);
     }
  }

  for (i=0;i<nwaterfalls;i++) {
    scaleobjs[i] = document.getElementById('clipscale'+i);
    scaleimgs0[i] = document.images["s0cale"+i];
    scaleimgs1[i] = document.images["s1cale"+i];
    if (isTouchDev) {
       registerTouchEvents('clipscale'+i, imgtouch, touchXY);
       registerTouchEvents('blackbar'+i, imgtouch, touchXY);
    }
  }
}

// PA0SIM for frequency DWN and UP buttons repeat action
var stepperfreq = 0;
var freqrunstep=0.01;
var count_num_steps= 0;
var runspeed = 1;
var periodcount=-10; 					// -10 for delaying start run after a single step
function startrunfreq(stepdirection) {
   if (count_num_steps==0) {			// start the function only when not already running
	  stepperfreq = setInterval(function() {
    if (count_num_steps<400) {freqrunstep=0.01+((count_num_steps-10)*0.1); runspeed=2;}
    else {stoprunfreq(0,0)} 				// PA0SIM to prevent running for always
    if (count_num_steps>100) {freqrunstep=2*freqrunstep} // speed up run
    freqrunstep = freqrunstep*(periodcount==runspeed);
    setfreq(freq+freqrunstep*(stepdirection*2-1));
	  count_num_steps=count_num_steps+1;
	  if (periodcount>=runspeed) {periodcount=0}
	  periodcount=periodcount+1;
    }, 50);
   }
   else {stoprunfreq(1,0);}        // function was already running, so has to stop
}

// PA0SIM for frequency DWN and UP buttons repeat action
singlestep = 0; 							// this function is performed always (last in line)
function stoprunfreq(stepdirection,singlestep) {
	setfreq(freq+singlestep*(0.01*(stepdirection*2-1)));
	clearInterval(stepperfreq);
	count_num_steps= 0;
	periodcount=-10;
}

function document_soundapplet() {
  if (usejavasound) {
     if (typeof prep_javasound =="function") prep_javasound();
     else {
       script = document.createElement('script');
       script.src = 'websdr-javasound.js';
       script.type = 'text/javascript';
       document.body.appendChild(script);
     }
  } else {
     if (typeof prep_html5sound =="function") prep_html5sound();
     else {
       script = document.createElement('script');
       script.src = 'websdr-sound.js';
       script.type = 'text/javascript';
       document.body.appendChild(script);
     }
  }
}

function document_soundapplet() {
  if (usejavasound) {
     if (typeof prep_javasound =="function") prep_javasound();
     else {
       script = document.createElement('script');
       script.src = 'websdr-javasound.js';
       script.type = 'text/javascript';
       document.body.appendChild(script);
     }
  } else {
     if (typeof prep_html5sound =="function") prep_html5sound();
     else {
       script = document.createElement('script');
       script.src = 'websdr-sound.js';
       script.type = 'text/javascript';
       document.body.appendChild(script);
     }
  }
}

function stretch_waterfalls()
{
   setTimeout('stretch_waterfalls_do()',1);  
}
/*
function stretch_waterfalls_do()
{
  var wfc=document.getElementById('wfcontainer');
  var wfcc=document.getElementById('wfccontainer');
  
  if (!document.getElementById('wfwidecheckbox').checked || usejavawaterfall) {
    wfc.style.transform="";
    wfc.style.left="0px";
    wfc.style.width="";
    wfc.style.height="";
    wfcc.style.height="";
    wfscalex=1;
    return;
  }
  var w=document.body.offsetWidth || window.innerWidth;
  var style = document.body.currentStyle || window.getComputedStyle(document.body);
  var marginleft = parseFloat(style.marginLeft)-8;
  var marginright = parseFloat(style.marginRight)-18;
  w+=marginleft+marginright;
  var wd=w;
  if (w>1024) wd=1024;
  if (w<1024) w=1024;
  wfscalex=w/1024;
  wfc.style.transform="scale("+(w/1024)+")";
  wfc.style.left=(-marginleft)+"px";
  wfcc.style.height=(wfc.clientHeight*wfscalex)+"px";
}
*/
window.addEventListener('resize', stretch_waterfalls, false);

var rec_showtimer;
var rec_downloadurl;

function record_show()
{
   document.getElementById('reccontrol').innerHTML=Math.round(soundapplet.rec_length_kB())+" kB";
}

function record_start() { 
   document.getElementById('reccontrol').innerHTML=0+" kB";
   if (rec_downloadurl) { URL.revokeObjectURL(rec_downloadurl); rec_downloadurl=null; }
   rec_showtimer=setInterval('record_show()',250);
   soundapplet.rec_start(); 
}

function record_stop()
{
   clearInterval(rec_showtimer);
   var res = soundapplet.rec_finish();

   var wavhead = new ArrayBuffer(44);
   var dv=new DataView(wavhead);
   var i=0;
   var sr=Math.round(res.sr);
   dv.setUint8(i++,82);  dv.setUint8(i++,73); dv.setUint8(i++,70); dv.setUint8(i++,70); // RIFF  (is there really no less verbose way to initialize this thing?)
   dv.setUint32(i,res.len+44,true); i+=4;  // total length; WAV files are little-endian
   dv.setUint8(i++,87);  dv.setUint8(i++,65); dv.setUint8(i++,86); dv.setUint8(i++,69); // WAVE
   dv.setUint8(i++,102);  dv.setUint8(i++,109); dv.setUint8(i++,116); dv.setUint8(i++,32); // fmt
     dv.setUint32(i,16,true);   i+=4;   // length of fmt
     dv.setUint16(i,1,true);    i+=2;   // PCM
     dv.setUint16(i,1,true);    i+=2;   // mono
     dv.setUint32(i,sr,true);   i+=4;   // samplerate
     dv.setUint32(i,2*sr,true); i+=4;   // 2*samplerate
     dv.setUint16(i,2,true);    i+=2;   // bytes per sample
     dv.setUint16(i,16,true);   i+=2;   // bits per sample
   dv.setUint8(i++,100);  dv.setUint8(i++,97); dv.setUint8(i++,116); dv.setUint8(i++,97); // data
     dv.setUint32(i,res.len,true);  // length of data

   var wavdata = res.wavdata;
   wavdata.unshift(wavhead);

   var mimetype = 'application/binary';
   var bb = new Blob(wavdata, {type: mimetype});
   if (!bb) document.getElementById('recwarning').style.display="block";
   rec_downloadurl = window.URL.createObjectURL(bb);
   if (rec_downloadurl.indexOf('http')>=0) document.getElementById('recwarning').style.display="block";
   var fname='';
   try {
      fname=(new Date().toISOString()).replace(/\.[0-9]{3}/,"");
   } catch (e) {};
   fname="websdr_recording_"+fname+"_"+nominalfreq().toFixed(1)+"kHz.wav";
   document.getElementById('reccontrol').innerHTML="<a href='"+rec_downloadurl+"' download='"+fname+"'>download</a>";
}

function record_click()
{
   var bt=document.getElementById('recbutton');
   if (bt.innerHTML=="stop") {
      bt.innerHTML="start";
      record_stop();
   } else {
      bt.innerHTML="stop";
      record_start();
   }
}

function sendchat()
{
  timeout_idle_restart()
  var xmlHttp;
  try { xmlHttp=new XMLHttpRequest(); }
    catch (e) { try { xmlHttp=new ActiveXObject("Msxml2.XMLHTTP"); }
      catch (e) { try { xmlHttp=new ActiveXObject("Microsoft.XMLHTTP"); }
        catch (e) { alert("Your browser does not support AJAX!"); return false; } } }
  var url="/~~chat";
  var msg=encodeURIComponent(document.chatform.chat.value);
  url=url+"?name="+encodeURIComponent(document.usernameform.username.value)+"&msg="+encodeURIComponent(document.chatform.chat.value);
  xmlHttp.open("GET",url,true);
  xmlHttp.send(null);
  document.chatform.chat.value="";
  return false;
}

function chatnewline(s)
{
  var o=document.getElementById('chatboxnew');
  if (!o) return;
  if (s[0]=='-') {
     var div=document.createElement('div');
     div.innerHTML=s;
     s=div.innerHTML;
     var re=new RegExp('<br>'+s.substring(1).replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&")+'.*','g');
     o.innerHTML=o.innerHTML.replace(re,'<br>');
     return;
  }
  // chatbox-anti-spam - replaces part of the chat string with new line...very raw but works - Maintained by ON5HB
  var spam=s.toLowerCase();
  if (spam.includes("v.ht/")) {s="Automated Spammer Detection activated! Bye bye spamdude :-)";}
  if (spam.includes("fr49.ru/")) {s="Automated Spammer Detection activated! Bye bye spamdude :-)";}
  if (spam.includes("worty.co/")) {s="Automated Spammer Detection activated! Bye bye spamdude :-)";}
  if (spam.includes("ruslekar.com/")) {s="Automated Spammer Detection activated! Bye bye spamdude :-)";}
  if (spam.includes("Ñ€Ð°Ð´Ð¸Ð¾Ð¼Ð°Ð³Ð°Ð·Ð¸Ð½")) {s="Automated Spammer Detection activated! Bye bye spamdude :-)";}
  if (spam.includes("hamradio.top/")) {s="Automated Spammer Detection activated! Bye bye spamdude :-)";}
  if (spam.includes("bit.ly/")) {s="Automated Spammer Detection activated! Bye bye spamdude :-)";}
  if (spam.includes("PL-398BT")) {s="Automated Spammer Detection activated! Bye bye spamdude :-)";}
  if (spam.includes("berlin")) {s="Automated Spammer Detection activated! Bye bye spamdude :-)";}
  if (spam.includes("@@@band")) {s="";}
  if (spam.includes("â˜ª ")) {s="";}
  if (spam.includes("â˜¾â˜† ")) {s="";}  
  if (spam.includes("â˜ªï¸")) {s="";} 
  if (spam.includes("::ffff")) {s="You can not use the chatbox without a name or callsign, sorry";}
  if (spam.includes("â€Š")) {s="You can not use the chatbox without a name or callsign, sorry";}
  if (spam.includes("unknown")) {s="You can not use the chatbox without a name or callsign, sorry";}  
  if ((spam.substring(10,11)) == ':') {s="You can not use the chatbox without a name or callsign, sorry";}

  // add line to chatbox
  o.innerHTML+='<br>'+s+'\n';
  o.scrollTop=o.scrollHeight;
}

function sendlogclear()
{
  document.logform.comment.value="";
}

function sendlog()
{
  var xmlHttp;
  try { xmlHttp=new XMLHttpRequest(); }
    catch (e) { try { xmlHttp=new ActiveXObject("Msxml2.XMLHTTP"); }
      catch (e) { try { xmlHttp=new ActiveXObject("Microsoft.XMLHTTP"); }
        catch (e) { alert("Your browser does not support AJAX!"); return false; } } }
  var url="/~~loginsert";
  url=url
     +"?name="+encodeURIComponent(document.usernameform.username.value)
     +"&freq="+nominalfreq()
     +"&call="+encodeURIComponent(document.logform.call.value)
     +"&comment="+encodeURIComponent(document.logform.comment.value)
     ;
  xmlHttp.open("GET",url,true);
  xmlHttp.send(null);
  document.logform.call.value="";
  document.logform.comment.value="";
  xmlHttp.onreadystatechange=function()
    {
    if(xmlHttp.readyState==4)
      {
      document.logform.comment.value=xmlHttp.responseText;
      }
    }
  setTimeout("document.logform.comment.value=''",1000);
  return false;
}

function ip2geo(id)
{
  var xhttp = new XMLHttpRequest();
  
  xhttp.open("GET","http://ip-api.com/csv?fields=countryCode,city", true);
  xhttp.send();
  xhttp.onreadystatechange = function()
  {
    if (xhttp.readyState == 4 && xhttp.status == 200) { geo = xhttp.responseText, document.getElementById(id).value = geo }
    else { document.getElementById(id).value = (" ") }
    setTimeout( function() {if (document.getElementById(id).value == "" ) {window.location.href="access.html"} }, 1211);
    setTimeout( function() {if (document.getElementById(id).value.indexOf("::ffff_") >=0 ) {window.location.href="access.html"} }, 1213);
    setTimeout( function() {if (document.getElementById(id).value.indexOf("undefined") >=0 ) {window.location.href="access.html"} }, 1214);
    setTimeout( function() {if (document.getElementById(id).value.indexOf("invalid") >=0 ) {window.location.href="access.html"} }, 1215);
    setTimeout( function() {if (document.getElementById(id).value.indexOf("error") >=0 ) {window.location.href="access.html"} }, 1216);
    setTimeout( function() { document.usernameform.username.value = document.getElementById(id).value }, 500);
    setTimeout( function() { document.usernameform.username.value = document.getElementById(id).value }, 1400);
  }
}

function debug(a)
{
   console.log(a);
}

function  toggle_info (info_type, info_mode='LSB')
{
	e = document.getElementById(info_type+"_info");
	if (!e) return;   // there is no "mode_info" element in this layout
	if  (info_type=='mode') {
		e.textContent=info_mode
	}
	else if (info_type=='nr' && info_mode==0) {
		document.getElementById(info_type+"_info").classList.remove('is_on');
	}
	else if (info_type=='agc') {
		if (e.className.includes('is_off') && info_type!=='nr') {
			document.getElementById(info_type+"_info").classList.remove('is_off');
		}
		else  {
			document.getElementById(info_type+"_info").classList.add('is_off');
		}
	}
	else {
		if (e.className.includes('is_on') && info_type!=='nr') {
			document.getElementById(info_type+"_info").classList.remove('is_on');
		}
		else  {
			document.getElementById(info_type+"_info").classList.add('is_on');
		}
	}
}

function background_load()
{
	if (document.getElementsByTagName('body')[0].style.background.includes('bg6')) { 
		document.body.style.background ='#bedcd7'
	} 
	else {
		document.body.style.background = 'url(sv1btl/bg6.jpg) no-repeat center center fixed';
		document.body.style.backgroundSize= 'cover';
	} 
	settings_store();
}

function preloader () {
	document.getElementsByClassName('loader')[0].classList.add('loaded_hiding');
	window.setTimeout(function () {
      document.getElementsByClassName('loader')[0].classList.add('loaded');
      document.getElementsByClassName('loader')[0].remove('loaded_hiding');
    }, 700);
}

  $(window).on('load', function() {
	window.setTimeout(preloader, 500)
  }
 );

//----------------------------------------------------------------------------------------
// Other things


function wfbright() {
  var wfdiv = document.querySelectorAll("#wfcdiv0, #wfcdiv1, #wfcdiv2, #wfcdiv3, #wfcdiv4, #wfcdiv5, #wfcdiv6, #wfcdiv7, #wfcdiv8, #wfcdiv9"); //selects all ID's
  console.log(wfdiv); //Stores those ID's in an array
  
  var br = document.getElementById("wf-brightness2"); 
  
 wfdiv[0].style.filter = "brightness(" + br.value + "%) sepia(0) invert(0) grayscale(0) blur(0px)hue-rotate(0deg) url(#svgGradientMap)";
 wfdiv[1].style.filter = "brightness(" + br.value + "%) sepia(0) invert(0) grayscale(0) blur(0px)hue-rotate(0deg) url(#svgGradientMap)";
 wfdiv[2].style.filter = "brightness(" + br.value + "%) sepia(0) invert(0) grayscale(0) blur(0px)hue-rotate(0deg) url(#svgGradientMap)";
 wfdiv[3].style.filter = "brightness(" + br.value + "%) sepia(0) invert(0) grayscale(0) blur(0px)hue-rotate(0deg) url(#svgGradientMap)";
 wfdiv[4].style.filter = "brightness(" + br.value + "%) sepia(0) invert(0) grayscale(0) blur(0px)hue-rotate(0deg) url(#svgGradientMap)";
 wfdiv[5].style.filter = "brightness(" + br.value + "%) sepia(0) invert(0) grayscale(0) blur(0px)hue-rotate(0deg) url(#svgGradientMap)";
 wfdiv[6].style.filter = "brightness(" + br.value + "%) sepia(0) invert(0) grayscale(0) blur(0px)hue-rotate(0deg) url(#svgGradientMap)";
 wfdiv[7].style.filter = "brightness(" + br.value + "%) sepia(0) invert(0) grayscale(0) blur(0px)hue-rotate(0deg) url(#svgGradientMap)";
 wfdiv[8].style.filter = "brightness(" + br.value + "%) sepia(0) invert(0) grayscale(0) blur(0px)hue-rotate(0deg) url(#svgGradientMap)";
 wfdiv[9].style.filter = "brightness(" + br.value + "%) sepia(0) invert(0) grayscale(0) blur(0px)hue-rotate(0deg) url(#svgGradientMap)";
}

function wfcontrast() {
  var wfdiv = document.querySelectorAll("#wfcdiv0, #wfcdiv1, #wfcdiv2, #wfcdiv3, #wfcdiv4, #wfcdiv5, #wfcdiv6, #wfcdiv7, #wfcdiv8, #wfcdiv9"); //selects all ID's
  console.log(wfdiv); //Stores those ID's in an array 
  
  var co = document.getElementById("wf-contrast2"); 
    
 wfdiv[0].style.filter = "contrast(" + co.value + "%) sepia(0) invert(0) grayscale(0) blur(0px)hue-rotate(0deg) url(#svgGradientMap)";
 wfdiv[1].style.filter = "contrast(" + co.value + "%) sepia(0) invert(0) grayscale(0) blur(0px)hue-rotate(0deg) url(#svgGradientMap)";
 wfdiv[2].style.filter = "contrast(" + co.value + "%) sepia(0) invert(0) grayscale(0) blur(0px)hue-rotate(0deg) url(#svgGradientMap)";
 wfdiv[3].style.filter = "contrast(" + co.value + "%) sepia(0) invert(0) grayscale(0) blur(0px)hue-rotate(0deg) url(#svgGradientMap)";
 wfdiv[4].style.filter = "contrast(" + co.value + "%) sepia(0) invert(0) grayscale(0) blur(0px)hue-rotate(0deg) url(#svgGradientMap)";
 wfdiv[5].style.filter = "contrast(" + co.value + "%) sepia(0) invert(0) grayscale(0) blur(0px)hue-rotate(0deg) url(#svgGradientMap)";
 wfdiv[6].style.filter = "contrast(" + co.value + "%) sepia(0) invert(0) grayscale(0) blur(0px)hue-rotate(0deg) url(#svgGradientMap)";
 wfdiv[7].style.filter = "contrast(" + co.value + "%) sepia(0) invert(0) grayscale(0) blur(0px)hue-rotate(0deg) url(#svgGradientMap)";
 wfdiv[8].style.filter = "contrast(" + co.value + "%) sepia(0) invert(0) grayscale(0) blur(0px)hue-rotate(0deg) url(#svgGradientMap)";
 wfdiv[9].style.filter = "contrast(" + co.value + "%) sepia(0) invert(0) grayscale(0) blur(0px)hue-rotate(0deg) url(#svgGradientMap)";
}

// ---------------- tongle ------------- //



function hide_memory_list() {
  var x = document.getElementById("memories");
  if (x.style.display === "none") {
    x.style.display = "block";
  } else {
    x.style.display = "none";
  }
}

// -------------- band button ----------- //

//SV2YJ - function to be used to dynamically render HTML elements for the bands based on the bandinfo table.
function document_bandbuttons() {
//<button type="button" class="btnBand" name="group0" id="btnB-0" onclick="setband(0)">10m</button>
 bandinfo.forEach(function(band,idx){
  var str = `<button type="button" class="btnBand" name="group0" id="btnB-${idx}" onclick="setband(${idx})">${band.name}</button>`;
  document.write(str);
  });
}
