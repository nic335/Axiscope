$(document).ready(function() {
    //Zoom
    const zoomImage = document.getElementById('zoom-image');
    const zoomSlider = document.getElementById('zoom-range');

    zoomSlider.addEventListener('input', (e) => {
      const zoomLevel = e.target.value;
      const scale = 1 + (zoomLevel / 100);
      zoomImage.style.transform = `scale(${scale})`;
      zoomImage.style.transformOrigin = 'center center';
    });
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