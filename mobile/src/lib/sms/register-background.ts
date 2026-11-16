// Imported first by the entry file (index.js) for its side effect: registers the SMS arrival task.
import { registerSmsArrivedTask } from "./background";

registerSmsArrivedTask();
