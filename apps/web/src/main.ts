import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';
import { appConfig } from './app/app.config';

// Bootstrap standalone (Angular 21). Sem NgModule raiz.
bootstrapApplication(App, appConfig).catch((err) => console.error(err));
