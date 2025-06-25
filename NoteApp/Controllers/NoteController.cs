using Microsoft.AspNetCore.Mvc;
using NoteApp.Models;
using NoteApp.Services;

namespace NoteApp.Controllers
{
    public class NoteController : Controller
    {
        private readonly INoteService _noteService;
        private readonly IDailyEntryService _entryService;

        public NoteController(INoteService noteService, IDailyEntryService entryService)
        {
            _noteService = noteService;
            _entryService = entryService;
        }

        public IActionResult Detail(int id, string? date)
        {
            var note = _noteService.GetNoteById(id);
            if (note == null) return NotFound();

            var selectedDate = string.IsNullOrEmpty(date) ? DateTime.Today : DateTime.Parse(date);
            var entries = _entryService.GetEntriesByNoteId(id);
            var selectedEntry = entries.FirstOrDefault(e => e.Date.Date == selectedDate.Date);

            ViewBag.SelectedDate = selectedDate;
            ViewBag.Entries = entries;
            ViewBag.Entry = selectedEntry;
            ViewBag.NoteTitle = note.Title;

            return View(note);
        }

        [HttpPost]
        [ValidateAntiForgeryToken]
        public IActionResult AddEntry(DailyEntry entry)
        {
            entry.Created_by = User.Identity?.Name ?? "guest";
            entry.UserId = User.Identity?.Name ?? "guest";
            _entryService.AddEntry(entry);
            return Ok();
        }

        [HttpPost]
        public IActionResult UpdateEntry(DailyEntry entry)
        {
            entry.Modified_by = User.Identity?.Name ?? "guest";
            _entryService.UpdateEntry(entry);
            return Ok();
        }
    }
}
