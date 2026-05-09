/**
 * Tag-safe typewriter: types HTML content into an element while preserving
 * inline tags (e.g. <span class="text-emerald-400">) for styling.
 * Used by both the main dashboard (org AI summary) and project-detail (AI analysis).
 */
(function (global) {
    function typeWriter(text, element, speed, callback) {
        element.innerHTML = '';
        const cleanText = (text || '').replace(/\*/g, '').replace(/\n/g, '<br>');
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = cleanText;
        const nodes = [];

        function walk(node) {
            node.childNodes.forEach(child => {
                if (child.nodeType === Node.TEXT_NODE) {
                    child.textContent.split('').forEach(char => nodes.push({ type: 'char', value: char, parent: child.parentNode }));
                } else if (child.nodeName === 'BR') {
                    nodes.push({ type: 'br' });
                } else if (child.nodeType === Node.ELEMENT_NODE) {
                    walk(child);
                }
            });
        }
        walk(tempDiv);

        let i = 0;
        const spanMap = new WeakMap();

        function type() {
            if (i >= nodes.length) {
                element.classList.add('loaded');
                if (callback) callback();
                return;
            }
            const node = nodes[i++];
            if (node.type === 'br') {
                element.appendChild(document.createElement('br'));
            } else if (node.parent && node.parent !== tempDiv) {
                let target = spanMap.get(node.parent);
                if (!target) {
                    target = document.createElement(node.parent.tagName || 'span');
                    target.className = node.parent.className || '';
                    element.appendChild(target);
                    spanMap.set(node.parent, target);
                }
                target.innerHTML += node.value;
            } else {
                element.innerHTML += node.value;
            }
            setTimeout(type, speed);
        }
        type();
    }

    global.typeWriter = typeWriter;
})(typeof window !== 'undefined' ? window : this);
