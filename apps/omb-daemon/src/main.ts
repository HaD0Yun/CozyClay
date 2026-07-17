#!/usr/bin/env node
import { start } from "./daemon.ts";

const index=process.argv.indexOf("--port");
const port=index>=0?Number(process.argv[index+1]):0;
if(!Number.isInteger(port)||port<0||port>65535)throw new Error("--port must be an integer from 0 through 65535");
await start({port,handlers:{inspect_project:async()=>({result:{fixture:true,scene_name:"Oh My Blender fixture"},resulting_revision_id:"0".repeat(64)})}});
