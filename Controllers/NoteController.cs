using ELAuth.Helper;
using Microsoft.AspNetCore.Mvc;
using NoteApp.Helper;
using NoteApp.Models;
using NoteApp.Services;
using static System.Runtime.InteropServices.JavaScript.JSType;

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
        [UserIdAuthorize]
        public IActionResult Detail(int id, string? date)
        {
            var note = _noteService.GetNoteById(id);
            if (note == null) return NotFound();

            var entries = _entryService.GetEntriesByNoteId(id);
            entries = entries.OrderByDescending(e => !string.IsNullOrEmpty(e.Date) ? Convert.ToDateTime(e.Date) : DateTime.Now).ToList();
            DateTime latest = entries.OrderByDescending(e => !string.IsNullOrEmpty(e.Date) ? Convert.ToDateTime(e.Date) : DateTime.Now).Select(e => !string.IsNullOrEmpty(e.Date) ? Convert.ToDateTime(e.Date) : DateTime.Now).FirstOrDefault();
            var selectedDate = string.IsNullOrEmpty(date) ? latest : DateTime.Parse(date);
            var selectedEntry = entries.FirstOrDefault(e => (!string.IsNullOrEmpty(e.Date) ? Convert.ToDateTime(e.Date) : DateTime.Now) == selectedDate.Date);

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
            var token = HttpContext.Session.GetString("Token");
            string? userId = JwtHelper.GetName(token);
            entry.Created_by = userId;
            entry.UserId = userId ?? "guest";
            _entryService.AddEntry(entry);
            return Ok();
        }

        [HttpPost]
        public IActionResult UpdateEntry(DailyEntry entry)
        {
            var token = HttpContext.Session.GetString("Token");
            string? userId = JwtHelper.GetName(token);
            entry.Modified_by = userId;
            _entryService.UpdateEntry(entry);
            return Ok();
        }

        // GET: /Note/Edit/5
        [HttpGet]
        public IActionResult EditDate(int id)
        {
            var entries = _entryService.GetEntryById(id);
            
            if (entries == null) return NotFound();
            return PartialView(entries);
        }

        [HttpPost]
        [ValidateAntiForgeryToken]
        public IActionResult UpdateDate(int id, string date)
        {
            var token = HttpContext.Session.GetString("Token");
            string? userId = JwtHelper.GetName(token);
            _entryService.UpdateDate(id, date, userId);
            return Ok();
        }

        [HttpPost]
        public IActionResult DeleteEntry(int id)
        {
            var token = HttpContext.Session.GetString("Token");
            string? userId = JwtHelper.GetName(token);
            _entryService.DeleteEntry(id, userId);
            return Ok();
        }
    }
}
