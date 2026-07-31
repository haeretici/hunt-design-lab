/**
 * Browser entry: route body#id → kernel app.
 */

'use strict';

const { initBatchBuilderApp } = require('./kernel/apps/batch-builder.js');
const { initAssetManagerApp } = require('./kernel/apps/asset-manager.js');
const { initGameApp } = require('./kernel/apps/game/app.js');
const {
    initSimulationAnalysisApp
} = require('./kernel/apps/simulation-analysis/app.js');
const {
    initSimBatchBuilderApp
} = require('./kernel/apps/sim-batch-builder.js');
const {
    initScenarioLabApp
} = require('./kernel/apps/scenario-lab/app.js');
const {
    initHuntEditorApp
} = require('./kernel/apps/hunt-editor/app.js');
const {
    initDesignerUiApp
} = require('./kernel/apps/designer-ui/app.js');
const { initWikiApp } = require('./kernel/apps/wiki/app.js');

document.addEventListener('DOMContentLoaded', () => {
    const bodyId = document.body ? document.body.id : '';

    if (bodyId === 'asset-manager-app') {
        initAssetManagerApp().catch((err) =>
            console.error('Error initializing Asset Manager app:', err)
        );
        return;
    }

    if (bodyId === 'batch-builder-app') {
        initBatchBuilderApp().catch((err) =>
            console.error('Error initializing Batch Builder app:', err)
        );
        return;
    }

    if (bodyId === 'sim-batch-builder-app') {
        initSimBatchBuilderApp().catch((err) =>
            console.error('Error initializing Sim Batch Builder app:', err)
        );
        return;
    }

    if (bodyId === 'game-app') {
        initGameApp().catch((err) =>
            console.error('Error initializing Hunt Simulator app:', err)
        );
        return;
    }

    if (bodyId === 'hunt-editor-app') {
        initHuntEditorApp().catch((err) =>
            console.error('Error initializing Hunt Editor app:', err)
        );
        return;
    }

    if (bodyId === 'designer-ui-app') {
        initDesignerUiApp().catch((err) =>
            console.error('Error initializing Designer UI app:', err)
        );
        return;
    }

    if (bodyId === 'scenario-lab-app') {
        initScenarioLabApp().catch((err) =>
            console.error('Error initializing Scenario Lab app:', err)
        );
        return;
    }

    if (bodyId === 'simulation-analysis-app') {
        initSimulationAnalysisApp().catch((err) =>
            console.error('Error initializing Simulation Analysis app:', err)
        );
        return;
    }

    if (bodyId === 'wiki-app') {
        initWikiApp().catch((err) =>
            console.error('Error initializing Wiki app:', err)
        );
    }
});
