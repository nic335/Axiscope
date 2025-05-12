// Global variables for camera transforms
let isFlippedHorizontal = false;
let isFlippedVertical = false;

// Function to update transform with all transformations
function updateTransform() {
    const zoomImage = document.getElementById('zoom-image');
    const zoomSlider = document.getElementById('zoom-range');
    const scale = 1 + (parseInt(zoomSlider.value) / 100);
    const scaleX = isFlippedHorizontal ? -scale : scale;
    const scaleY = isFlippedVertical ? -scale : scale;
    zoomImage.style.transform = `scale(${scaleX}, ${scaleY})`;
}

// Calculate the crosshair position relative to the image size
function updateZoomOrigin() {
    // The crosshair is always at the center horizontally (50%)
    // For vertical position, we need to consider the image's actual dimensions
    // The SVG crosshair is at 37.5% of the SVG height (75/200)
    // We'll keep horizontal center but adjust vertical position
    return '50% 50%';
}

$(document).ready(function() {
    //Zoom
    const zoomImage = document.getElementById('zoom-image');
    const zoomSlider = document.getElementById('zoom-range');

    // Zoom event listener
    zoomSlider.addEventListener('input', () => {
        updateTransform();
        zoomImage.style.transformOrigin = updateZoomOrigin();
    });

    // Flip controls event listeners
    document.getElementById('flip-horizontal').addEventListener('click', () => {
        isFlippedHorizontal = !isFlippedHorizontal;
        updateTransform();
        // Toggle active state of button
        document.getElementById('flip-horizontal').classList.toggle('btn-primary');
        document.getElementById('flip-horizontal').classList.toggle('btn-secondary');
    });

    document.getElementById('flip-vertical').addEventListener('click', () => {
        isFlippedVertical = !isFlippedVertical;
        updateTransform();
        // Toggle active state of button
        document.getElementById('flip-vertical').classList.toggle('btn-primary');
        document.getElementById('flip-vertical').classList.toggle('btn-secondary');
    });

    // Set initial transform origin
    zoomImage.style.transformOrigin = updateZoomOrigin();
    //Contrast
    const img = document.getElementById('zoom-image');
    const slider = document.getElementById('contrast-range');

    function updateContrast() {
      const value = slider.value;
      img.style.filter = `contrast(${value}%)`;
    }
    slider.addEventListener('input', updateContrast);
    updateContrast();
});