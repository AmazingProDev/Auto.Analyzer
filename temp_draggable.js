// Initialize Draggable Logic
function makeElementDraggable(headerEl, containerEl) {
    let startX = 0, startY = 0;
    let startLeft = 0, startTop = 0;

    headerEl.onmousedown = dragMouseDown;

    function dragMouseDown(e) {
        e = e || window.event;
        e.preventDefault();
        e.stopPropagation();

        // 1. Capture Mouse Start
        startX = e.clientX;
        startY = e.clientY;

        // 2. Lock current position in Left/Top coordinates (handling Right/Bottom transition)
        // We use offsetLeft/Top which gives us the element's distance from toggle-parent.
        // This is safe because even if positioned by 'right', offsetLeft is the calculated px value.
        startLeft = containerEl.offsetLeft;
        startTop = containerEl.offsetTop;

        // 3. Switch CSS to explicit Left/Top to enable dragging
        containerEl.style.left = startLeft + "px";
        containerEl.style.top = startTop + "px";
        containerEl.style.right = 'auto';
        containerEl.style.bottom = 'auto';
        containerEl.style.margin = '0'; // Prevent margin weirdness

        document.onmouseup = closeDragElement;
        document.onmousemove = elementDrag;

        headerEl.style.cursor = 'grabbing';
    }

    function elementDrag(e) {
        e = e || window.event;
        e.preventDefault();
        e.stopPropagation();

        // 4. Move based on Delta
        const dX = e.clientX - startX;
        const dY = e.clientY - startY;

        containerEl.style.left = (startLeft + dX) + "px";
        containerEl.style.top = (startTop + dY) + "px";
    }

    function closeDragElement() {
        document.onmouseup = null;
        document.onmousemove = null;
        headerEl.style.cursor = 'grab';
    }

    headerEl.style.cursor = 'grab';
}
