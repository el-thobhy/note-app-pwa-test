using Microsoft.AspNetCore.Mvc;
using NoteApp.Helper;
using NoteApp.Models;
using NoteApp.Services;
using System.Security.Claims;

namespace NoteApp.Controllers
{
    /// <summary>
    /// Controller untuk halaman collaboration room.
    /// Tidak memerlukan autentikasi — guest dan user biasa bisa akses.
    /// </summary>
    public class CollaborationController : Controller
    {
        private readonly INoteService _noteService;
        private readonly IDailyEntryService _entryService;

        public CollaborationController(INoteService noteService, IDailyEntryService entryService)
        {
            _noteService = noteService;
            _entryService = entryService;
        }

        /// <summary>
        /// Halaman utama — list semua public notes.
        /// </summary>
        public IActionResult Index()
        {
            // Redirect user yang belum login sama sekali ke halaman auth
            if (!User.Identity?.IsAuthenticated ?? true)
                return RedirectToAction("Index", "Auth");

            return View();
        }

        /// <summary>
        /// AJAX endpoint — ambil semua public notes.
        /// </summary>
        [HttpGet]
        public IActionResult GetPublicNotes()
        {
            try
            {
                var notes = _noteService.GetAllPublicNotes();
                foreach (var note in notes)
                    note.Entries = _noteService.GetAllDailyEntriesByNoteId(note.Id);

                return Json(new { success = true, data = notes });
            }
            catch (Exception ex)
            {
                return Json(new { success = false, message = ex.Message });
            }
        }

        /// <summary>
        /// Halaman editor collaboration untuk entry tertentu.
        /// Accessible oleh guest dan user — tidak ada [Authorize].
        /// </summary>
        public IActionResult Room(int noteId, string? date)
        {
            if (!User.Identity?.IsAuthenticated ?? true)
                return RedirectToAction("Index", "Auth");

            var note = _noteService.GetNoteById(noteId);
            if (note == null || !note.IsPublic)
                return NotFound("Room tidak ditemukan atau tidak public.");

            var entries = _entryService.GetEntriesByNoteId(noteId);
            entries = entries.OrderByDescending(e =>
                !string.IsNullOrEmpty(e.Date) ? Convert.ToDateTime(e.Date) : DateTime.Now).ToList();

            DateTime latest = entries
                .Select(e => !string.IsNullOrEmpty(e.Date) ? Convert.ToDateTime(e.Date) : DateTime.Now)
                .FirstOrDefault();

            ViewBag.SelectedDate = latest;
            ViewBag.Entries = _entryService.GetEntryListDateByNoteId(noteId);
            ViewBag.NoteTitle = note.Title;
            ViewBag.IsGuest = User.FindFirst("IsGuest")?.Value == "true";
            ViewBag.DisplayName = User.FindFirst("FullName")?.Value ?? User.Identity?.Name ?? "Guest";
            ViewBag.Avatar = User.FindFirst("Avatar")?.Value ?? "";

            // Warna konsisten dari ClaimTypes.Name (username)
            var username = User.Identity?.Name ?? User.FindFirst("FullName")?.Value ?? "";
            ViewBag.UserColor = ColorHelper.FromUsername(username);

            return View(note);
        }

        /// <summary>
        /// AJAX — ambil list entries untuk refresh sidebar.
        /// </summary>
        [HttpGet]
        public IActionResult GetPublicNoteEntries(int noteId)
        {
            try
            {
                var entries = _entryService.GetEntryListDateByNoteId(noteId);
                return Json(new { success = true, data = entries });
            }
            catch (Exception ex)
            {
                return Json(new { success = false, message = ex.Message });
            }
        }

        /// <summary>
        /// AJAX — ambil detail entry (sama seperti NoteController.GetDetailNote tapi public).
        /// </summary>
        [HttpGet]
        public IActionResult GetDetailNote(string? id, string? noteId)
        {
            try
            {
                if (!User.Identity?.IsAuthenticated ?? true)
                    return Json(new { success = false, message = "Unauthorized" });

                Models.DailyEntry entry = new();
                if (!string.IsNullOrEmpty(id))
                    entry = _entryService.GetEntryById(int.Parse(id));
                else if (!string.IsNullOrEmpty(noteId))
                    entry = _entryService.GetEntriesByNoteId(int.Parse(noteId)).FirstOrDefault();

                return Json(new { success = true, data = entry });
            }
            catch
            {
                return Json(new { success = false, message = "failed get detail" });
            }
        }

        /// <summary>
        /// AJAX — save entry. Guest tidak bisa save (IsGuest check di client).
        /// User biasa bisa save.
        /// </summary>
        [HttpPost]
        public IActionResult UpdateEntry(Models.DailyEntry entry)
        {
            var isGuest = User.FindFirst("IsGuest")?.Value == "true";
            if (isGuest)
                return Json(new { success = false, message = "Guest tidak bisa menyimpan." });

            var userId = User.FindFirst(ClaimTypes.Name)?.Value
                      ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value;

            entry.Modified_by = userId;
            _entryService.UpdateEntry(entry);
            return Json(new { success = true, message = "Tersimpan." });
        }
    }
}
