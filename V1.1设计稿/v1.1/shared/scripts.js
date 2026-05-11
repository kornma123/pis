// COREONE Inventory Management - Shared Scripts
// Version: 1.1
// Last Updated: 2026-04-23

// Modal Functions
function showModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
    }
}

function hideModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('active');
        document.body.style.overflow = '';
    }
}

function hideAllModals() {
    document.querySelectorAll('.modal-overlay.active').forEach(m => {
        m.classList.remove('active');
    });
    document.body.style.overflow = '';
}

// Close modal on Escape key
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        hideAllModals();
    }
});

// Close modal on overlay click (using event delegation for dynamically added modals)
document.addEventListener('click', function(e) {
    if (e.target.classList.contains('modal-overlay')) {
        hideModal(e.target.id);
    }
});

// Number Stepper Functionality
document.querySelectorAll('.number-stepper').forEach(stepper => {
    const input = stepper.querySelector('.stepper-input');
    const minusBtn = stepper.querySelector('.stepper-btn:first-child');
    const plusBtn = stepper.querySelector('.stepper-btn:last-child');

    if (minusBtn && input) {
        minusBtn.addEventListener('click', () => {
            const min = parseInt(input.min) || 0;
            const current = parseInt(input.value) || 0;
            if (current > min) {
                input.value = current - 1;
                input.dispatchEvent(new Event('change'));
            }
        });
    }

    if (plusBtn && input) {
        plusBtn.addEventListener('click', () => {
            const max = parseInt(input.max) || Infinity;
            const current = parseInt(input.value) || 0;
            if (current < max) {
                input.value = current + 1;
                input.dispatchEvent(new Event('change'));
            }
        });
    }
});

// Tree View Toggle
document.querySelectorAll('.tree-toggle').forEach(toggle => {
    toggle.addEventListener('click', function(e) {
        e.stopPropagation();
        const parent = this.closest('.tree-item');
        const children = parent.nextElementSibling;
        if (children && children.classList.contains('tree-children')) {
            children.style.display = children.style.display === 'none' ? 'block' : 'none';
            this.textContent = children.style.display === 'none' ? '▶' : '▼';
        }
    });
});

// Table Row Selection
document.querySelectorAll('table tbody tr').forEach(row => {
    row.addEventListener('click', function(e) {
        if (!e.target.closest('.actions') && !e.target.closest('button')) {
            this.closest('tbody').querySelectorAll('tr').forEach(r => r.classList.remove('selected'));
            this.classList.add('selected');
        }
    });
});

// Form Validation
function validateForm(form) {
    let isValid = true;
    form.querySelectorAll('[required]').forEach(field => {
        if (!field.value.trim()) {
            isValid = false;
            field.style.borderBottomColor = 'var(--red-60)';
        } else {
            field.style.borderBottomColor = '';
        }
    });
    return isValid;
}

// Confirmation Dialog
function confirmDelete(itemName, callback) {
    const confirmed = confirm(`确定要删除 "${itemName}" 吗？\n\n此操作不可恢复。`);
    if (confirmed && callback) {
        callback();
    }
    return confirmed;
}

// Toast Notification
function showToast(message, type = 'info') {
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    const icons = {
        success: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
        error: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
        warning: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
        info: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
    };

    toast.innerHTML = `
        ${icons[type] || icons.info}
        <span>${message}</span>
        <button class="toast-close" onclick="this.parentElement.remove()">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
        </button>
    `;
    
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'toastSlideOut 0.3s ease forwards';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Show Confirm Dialog
function showConfirm(title, message, onConfirm, onCancel) {
    const modal = document.createElement('div');
    modal.className = 'modal active';
    modal.innerHTML = `
        <div class="modal-overlay" onclick="this.parentElement.remove()"></div>
        <div class="modal-container" style="max-width: 400px;">
            <div class="modal-body">
                <div class="confirm-dialog">
                    <svg class="confirm-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="12" y1="8" x2="12" y2="12"/>
                        <line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    <div class="confirm-title">${title}</div>
                    <div class="confirm-message">${message}</div>
                    <div class="confirm-actions">
                        <button class="btn btn-secondary" onclick="this.closest('.modal').remove(); ${onCancel ? onCancel + '()' : ''}">取消</button>
                        <button class="btn btn-primary" onclick="this.closest('.modal').remove(); ${onConfirm}()">确认</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

// Form Validation Helper
function validateRequired(input) {
    const value = input.value.trim();
    const formGroup = input.closest('.form-group');
    
    if (!value) {
        formGroup.classList.add('has-error');
        let errorEl = formGroup.querySelector('.form-error');
        if (!errorEl) {
            errorEl = document.createElement('div');
            errorEl.className = 'form-error';
            errorEl.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="12"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <span>此字段为必填项</span>
            `;
            input.parentElement.appendChild(errorEl);
        }
        return false;
    } else {
        formGroup.classList.remove('has-error');
        const errorEl = formGroup.querySelector('.form-error');
        if (errorEl) errorEl.remove();
        return true;
    }
}

// Show Loading
function showLoading(container) {
    const loading = document.createElement('div');
    loading.className = 'loading-overlay';
    loading.innerHTML = `
        <div style="text-align: center;">
            <div class="loading-spinner"></div>
            <div class="loading-text">加载中...</div>
        </div>
    `;
    container.style.position = 'relative';
    container.appendChild(loading);
    return loading;
}

function hideLoading(loading) {
    if (loading && loading.parentElement) {
        loading.remove();
    }
}

// Search Debounce
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Date Formatter
function formatDate(date, format = 'YYYY-MM-DD') {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    
    return format
        .replace('YYYY', year)
        .replace('MM', month)
        .replace('DD', day);
}

// Number Formatter
function formatNumber(num, decimals = 0) {
    return Number(num).toLocaleString('zh-CN', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    });
}

// Currency Formatter
function formatCurrency(amount) {
    return '¥' + formatNumber(amount, 2);
}

// Calculate Days Until Expiry
function getDaysUntilExpiry(expiryDate) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const expiry = new Date(expiryDate);
    const diffTime = expiry - today;
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

// Get Expiry Status
function getExpiryStatus(days) {
    if (days < 0) return { status: 'expired', label: '已过期', class: 'tag-critical' };
    if (days <= 7) return { status: 'danger', label: '临近过期', class: 'tag-danger' };
    if (days <= 30) return { status: 'warning', label: '即将过期', class: 'tag-warning' };
    return { status: 'normal', label: '正常', class: 'tag-normal' };
}

// Batch Select
function initBatchSelect() {
    const selectAll = document.querySelector('.select-all');
    const checkboxes = document.querySelectorAll('.batch-checkbox');
    
    if (selectAll) {
        selectAll.addEventListener('change', function() {
            checkboxes.forEach(cb => cb.checked = this.checked);
        });
    }
}

// Print Function
function printPage() {
    window.print();
}

// Export to CSV
function exportToCSV(data, filename) {
    const csv = convertToCSV(data);
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
}

function convertToCSV(data) {
    if (!data || !data.length) return '';
    const headers = Object.keys(data[0]);
    const rows = data.map(row => headers.map(h => row[h]).join(','));
    return [headers.join(','), ...rows].join('\n');
}

// Initialize on DOM Ready
document.addEventListener('DOMContentLoaded', function() {
    // Initialize batch select
    initBatchSelect();
    
    // Add print styles
    const printStyles = document.createElement('style');
    printStyles.textContent = `
        @media print {
            .nav-tabs, .sidebar, .btn, .actions, .pagination { display: none !important; }
            .content { margin-left: 0 !important; padding: 0 !important; }
            .card { break-inside: avoid; }
        }
    `;
    document.head.appendChild(printStyles);
});

// ==================== 防重复提交机制 ====================
function withLoading(button, callback, loadingText = '提交中...') {
    if (button.disabled) return;
    
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = loadingText;
    button.classList.add('loading');
    
    const restore = () => {
        button.disabled = false;
        button.textContent = originalText;
        button.classList.remove('loading');
    };
    
    try {
        const result = callback();
        if (result instanceof Promise) {
            return result.finally(restore);
        }
        restore();
        return result;
    } catch (e) {
        restore();
        throw e;
    }
}

// ==================== 空状态组件 ====================
function renderEmptyState(container, options = {}) {
    const {
        icon = 'empty',
        title = '暂无数据',
        description = '',
        actionText = '',
        actionCallback = null
    } = options;
    
    const icons = {
        empty: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
        search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
        error: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'
    };
    
    const html = `
        <div class="empty-state" role="status" aria-label="${title}">
            <div class="empty-state-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    ${icons[icon] || icons.empty}
                </svg>
            </div>
            <div class="empty-state-title">${title}</div>
            ${description ? `<div class="empty-state-description">${description}</div>` : ''}
            ${actionText ? `<button class="btn btn-primary btn-sm empty-state-action" ${actionCallback ? `onclick="${actionCallback}"` : ''}>${actionText}</button>` : ''}
        </div>
    `;
    
    if (typeof container === 'string') {
        container = document.querySelector(container);
    }
    if (container) {
        container.innerHTML = html;
    }
    return html;
}

// ==================== ARIA支持 ====================
function initAccessibility() {
    document.querySelectorAll('.modal').forEach(modal => {
        if (!modal.hasAttribute('role')) {
            modal.setAttribute('role', 'dialog');
        }
        if (!modal.hasAttribute('aria-modal')) {
            modal.setAttribute('aria-modal', 'true');
        }
    });
    
    document.querySelectorAll('button:not([aria-label])').forEach(btn => {
        const text = btn.textContent.trim();
        if (text && text.length < 20) {
            btn.setAttribute('aria-label', text);
        }
    });
    
    document.querySelectorAll('svg:not([aria-hidden])').forEach(svg => {
        if (!svg.closest('button') && !svg.hasAttribute('aria-label')) {
            svg.setAttribute('aria-hidden', 'true');
        }
    });
}

document.addEventListener('DOMContentLoaded', initAccessibility);
