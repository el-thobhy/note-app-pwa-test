// Please see documentation at https://learn.microsoft.com/aspnet/core/client-side/bundling-and-minification
// for details on configuring this project to bundle and minify static web assets.

// set active item
document.addEventListener("DOMContentLoaded", function () {
    const listItems = document.querySelectorAll("li[data-date]");

    // --- Auto set active saat reload sesuai query string ---
    const params = new URLSearchParams(window.location.search);
    const selectedDate = params.get("date");

    if (selectedDate) {
        listItems.forEach(li => {
            if (li.getAttribute("data-date") === selectedDate) {
                li.classList.add("active", "bg-label-primary");
            }
        });
    }

    // --- Handle on click ---
    listItems.forEach(li => {
        li.addEventListener("click", function () {
            const clickedDate = li.getAttribute("data-date");
            const id = li.getAttribute("data-identry");

            // reset semua li
            listItems.forEach(item => item.classList.remove("active", "bg-label-primary"));

            // set active yang diklik
            li.classList.add("active", "bg-label-primary");

            // update querystring
            const params = new URLSearchParams(window.location.search);
            params.set("date", clickedDate);
            window.history.replaceState({}, "", `${location.pathname}?${params}`);
            localStorage.setItem("latestOn", id);
        });
    });
});


// Write your JavaScript code.
function openEditModalEntries(id) {
    $.get(`/Note/EditDate/${id}`, function (html) {
        $("#editModalContentEntries").html(html);
        $("#editModalEntries").modal('show');
    });
}

// OPEN Delete Modal
function openDeleteModalEntries(id, date) {
    $("#deleteNoteIdEntries").val(id);
    $("#deleteNoteTitleEntries").text(date);
    $("#deleteModalEntries").modal('show');
}

// DELETE Note
$("#deleteNoteFormEntries").submit(function (e) {
    //loading spinner
    const $btn = $("#deleteBtnEntries");
    const originalHtml = $btn.html();
    $btn.prop("disabled", true).html(`<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span> Menyimpan...`);

    e.preventDefault();
    const id = $("#deleteNoteIdEntries").val();
    $.post("/Note/DeleteEntry?id=" + id, function () {

        location.reload();
        $("#deleteModalEntries").modal('hide');
    });
});

//For PWA
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('../../sw.js')
        .then(reg => console.log("Service Worker registerd", reg))
        .catch(err => console.log("Service Worker failed", err));
}


let deferredPrompt;
const btnInstall = document.getElementById("btnInstall");

window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    btnInstall.style.display = "block";
});

btnInstall.addEventListener("click", async () => {
    if (!deferredPrompt) return;

    deferredPrompt.prompt();

    const { outcome } = await deferredPrompt.userChoice;
    console.log(`User response to install: ${outcome}`);

    //reset agar tidak dipanggil 2 kali
    deferredPrompt = null;
    btnInstall.style.display = "none";
});

window.addEventListener("appinstalled", () => {
    console.log("PWA was installed");
});


//tooltip
document.addEventListener("DOMContentLoaded", () => {
    const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
    tooltipTriggerList.map(el => new bootstrap.Tooltip(el));
});
