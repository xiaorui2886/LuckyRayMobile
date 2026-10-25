/** Synthetic local-only browser fixture; not imported by the application. */
import React,{useRef,useState} from 'react';
import '../../src/features/graph/mobileGraph.css';
import {createRoot} from 'react-dom/client';
import {MobileGraphCanvas,type MobileGraphCanvasHandle} from '../../src/features/graph/MobileGraphCanvas';
import type {Camera} from '../../src/features/graph/core/graphCamera';
const seed={nodes:[{id:1,key:'synthetic-one',label:'Synthetic document',type:'note' as const}],edges:[],source:'real' as const};
function Fixture(){const ref=useRef<MobileGraphCanvasHandle>(null);const [camera,setCamera]=useState<Camera>();const [selected,select]=useState<string|null>(null);const [opens,setOpens]=useState(0);return <><div style={{width:400,height:600,position:'relative'}}><MobileGraphCanvas ref={ref} seed={seed} settings={{}} selectedKey={selected} camera={camera} onCameraChange={setCamera} onSelect={select} onOpen={()=>setOpens(n=>n+1)}/></div><output id="camera">{JSON.stringify(camera)}</output><output id="selected">{selected}</output><output id="opens">{opens}</output><button id="fit" onClick={()=>ref.current?.fit()}>Fit</button><button id="capture" onClick={()=>void ref.current?.capture().then(b=>document.getElementById('capture')!.setAttribute('data-size',String(b.size)))}>Capture</button></>}
createRoot(document.getElementById('root')!).render(<Fixture/>);
