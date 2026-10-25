/** Geometry shared by touch and pen transports; never an overlay or a route. */
export type PaperSide = 'left' | 'right' | null;
export function paperSideOffset(side:PaperSide,width:number){return side==='left'?width:side==='right'?-width:0}
export function paperDragOffset(origin:number,delta:number,width:number){
 if(width<=0)return 0;
 const value=origin+delta;
 // Resist overdrag continuously, but cap exposed empty space on a long pull.
 const limit=Math.min(32,width*.1);
 const rubber=(excess:number)=>limit*(1-Math.exp(-excess*.16/limit));
 return value>width?width+rubber(value-width):value< -width?-width-rubber(-value-width):value;
}
export function paperSettleSide(origin:PaperSide,offset:number,width:number,velocity:number):PaperSide{
 if(width<=0)return origin;
 // A small reverse flick cancels opening; a long slow drag still works.
 const moved=Math.abs(offset-paperSideOffset(origin,width));
 const raw=offset+(moved>=32&&Math.abs(velocity)>.35?Math.max(-2.4,Math.min(2.4,velocity))*130:0);
 const projected=offset>0?Math.max(0,raw):offset<0?Math.min(0,raw):0;
 const threshold=width*(origin? .58:.32);
 return projected>threshold?'left':projected< -threshold?'right':null;
}
export function paperAxis(dx:number,dy:number,elapsed:number):'x'|'y'|'wait'|'cancel'{
 if(elapsed>360&&Math.max(Math.abs(dx),Math.abs(dy))<12)return 'cancel';
 if(Math.abs(dy)>9&&Math.abs(dy)>=Math.abs(dx)*.8)return 'y';
 if(Math.abs(dx)>12&&Math.abs(dx)>Math.abs(dy)*1.45)return 'x';
 return 'wait';
}

/** Short remaining trips should not linger for the full-panel duration. */
export function paperSettleDuration(distance:number,width:number,reduced=false){
 if(reduced||width<=0||Math.abs(distance)<.5)return 0;
 return Math.round(160+100*Math.min(1,Math.abs(distance)/width));
}
