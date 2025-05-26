// Global variables for camera transforms
let isFlippedHorizontal = false;
let isFlippedVertical = false;

// Function to get crosshair position from SVG
function getCrosshairPosition() {
    const svg = document.querySelector('.img-overlay-wrap svg');
    const circle = svg.querySelector('circle');
    return {
        x: parseFloat(circle.getAttribute('cx')),
        y: parseFloat(circle.getAttribute('cy'))
    };
}

// Function to calculate zoom origin based on crosshair
function calculateZoomOrigin() {
    const crosshair = getCrosshairPosition();
    // Convert SVG coordinates (200x200) to percentages
    const xPercent = (crosshair.x / 200) * 100;
    const yPercent = (crosshair.y / 200) * 100;
    return { x: xPercent, y: yPercent };
}

// Function to update transform with all transformations
function updateTransform() {
    const zoomImage = document.getElementById('zoom-image');
    const zoomSlider = document.getElementById('zoom-range');
    const scale = 1 + (parseInt(zoomSlider.value) / 100);
    const scaleX = isFlippedHorizontal ? -scale : scale;
    const scaleY = isFlippedVertical ? -scale : scale;
    
    // Get zoom origin based on crosshair position
    const origin = calculateZoomOrigin();
    
    // Set transform origin to crosshair position
    zoomImage.style.transformOrigin = `${origin.x}% ${origin.y}%`;
    
    // Apply scale transform without translate
    zoomImage.style.transform = `scale(${scaleX}, ${scaleY})`;
}

$(document).ready(function() {
    //Zoom
    const zoomImage = document.getElementById('zoom-image');
    const zoomSlider = document.getElementById('zoom-range');

    // Zoom event listener
    zoomSlider.addEventListener('input', () => {
        updateTransform();
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

    // Set initial transform
    updateTransform();
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