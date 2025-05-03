<template>
    <div class="axiscope-view">
        <v-card>
            <v-card-title>AxisScope Camera</v-card-title>
            <v-card-text>
                <div class="camera-feed">
                    <!-- Camera feed will go here -->
                    <img :src="cameraUrl" v-if="cameraUrl" alt="Camera Feed" />
                    <div v-else class="no-feed">No camera feed available</div>
                </div>
                <div class="camera-controls mt-4">
                    <v-btn color="primary" @click="startStream">
                        Start Stream
                    </v-btn>
                    <v-btn color="error" class="ml-4" @click="stopStream">
                        Stop Stream
                    </v-btn>
                </div>
            </v-card-text>
        </v-card>
    </div>
</template>

<script lang="ts">
import Component from 'vue-class-component'
import { Mixins } from 'vue-property-decorator'
import BaseMixin from '@/components/mixins/base'

@Component
export default class AxiscopeView extends Mixins(BaseMixin) {
    cameraUrl: string | null = null

    startStream() {
        // Connect to your AxisScope service
        this.cameraUrl = `http://${window.location.hostname}:3000/video_feed`
    }

    stopStream() {
        this.cameraUrl = null
    }
}
</script>

<style scoped>
.camera-feed {
    width: 100%;
    max-width: 800px;
    margin: 0 auto;
    background: #000;
    min-height: 400px;
    display: flex;
    align-items: center;
    justify-content: center;
}

.camera-feed img {
    width: 100%;
    height: auto;
}

.no-feed {
    color: #fff;
    text-align: center;
    padding: 2rem;
}
</style>
