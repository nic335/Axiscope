import { Plugin } from '@/store/plugin'
import { Component } from 'vue-property-decorator'
import AxiscopeView from './components/AxiscopeView.vue'

@Component
export default class AxiscopePlugin extends Plugin {
    name = 'AxisScope'
    version = '1.0.0'
    description = 'Advanced camera control for 3D printing'

    // Plugin configuration
    config = {
        enabled: true,
        servicePort: 3000
    }

    async init() {
        // Register the main view component as a tab
        this.registerRoute({
            name: 'Axiscope',
            path: '/axiscope',
            component: AxiscopeView,
            icon: 'mdi-camera-iris',
            navbar: true,
            position: 'bottom',
            // Add metadata for better integration
            meta: {
                pluginName: this.name,
                pluginVersion: this.version,
                requiresService: 'axiscope'
            }
        })

        // Initialize connection to AxisScope service
        await this.initializeService()
    }

    private async initializeService() {
        try {
            const response = await fetch(`http://${window.location.hostname}:${this.config.servicePort}/status`)
            if (!response.ok) {
                console.warn('AxisScope service not responding')
            }
        } catch (error) {
            console.error('Failed to connect to AxisScope service:', error)
        }
    }

    // Cleanup when plugin is disabled
    async onDisable() {
        // Add cleanup code here if needed
    }
}
