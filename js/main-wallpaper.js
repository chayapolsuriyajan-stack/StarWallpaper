import { Engine } from './engine.js';
import { connectLively } from './lively-bridge.js';

const engine = new Engine();
connectLively(engine);
engine.start();
