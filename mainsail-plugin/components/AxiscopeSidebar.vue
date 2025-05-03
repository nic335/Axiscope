<template>
    <div class="axiscope-sidebar">
        <v-list-item>
            <v-list-item-icon>
                <v-icon>mdi-camera</v-icon>
            </v-list-item-icon>
            <v-list-item-content>
                <v-list-item-title>Camera Status</v-list-item-title>
                <v-list-item-subtitle>{{ status }}</v-list-item-subtitle>
            </v-list-item-content>
        </v-list-item>
        <v-divider></v-divider>
        <v-list-item>
            <v-list-item-content>
                <v-btn block color="primary" @click="toggleStream">
                    {{ isStreaming ? 'Stop Stream' : 'Start Stream' }}
                </v-btn>
            </v-list-item-content>
        </v-list-item>
    </div>
</template>

<script lang="ts">
import Component from 'vue-class-component'
import { Mixins } from 'vue-property-decorator'
import BaseMixin from '@/components/mixins/base'

@Component
export default class AxiscopeSidebar extends Mixins(BaseMixin) {
    isStreaming = false

    get status() {
        return this.isStreaming ? 'Streaming' : 'Stopped'
    }

    toggleStream() {
        this.isStreaming = !this.isStreaming
        // Implement actual stream toggle logic here
    }
}
</script>
