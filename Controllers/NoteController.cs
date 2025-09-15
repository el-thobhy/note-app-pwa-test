using ELAuth.Helper;
using Microsoft.AspNetCore.Mvc;
using NoteApp.Helper;
using NoteApp.Models;
using NoteApp.Services;
using NoteAppPWA.Controllers;
using NoteAppPWA.Helper;
using NoteAppPWA.Models;
using static System.Runtime.InteropServices.JavaScript.JSType;

namespace NoteApp.Controllers
{
    public class NoteController : BaseController
    {
        private readonly INoteService _noteService;
        private readonly IDailyEntryService _entryService;
        private readonly IEmailHelper _emailHelper;
        private readonly IConfiguration _configuration;

        public NoteController(INoteService noteService, IDailyEntryService entryService, IConfiguration configuration)
        {
            _configuration = configuration;
            _noteService = noteService;
            _entryService = entryService;
            _emailHelper = new EmailHelper(_configuration);
        }
        [UserIdAuthorize]
        public IActionResult Detail(int id, string? date)
        {
            var note = _noteService.GetNoteById(id);
            if (note == null) return NotFound();

            var entries = _entryService.GetEntriesByNoteId(id);
            entries = entries.OrderByDescending(e => !string.IsNullOrEmpty(e.Date) ? Convert.ToDateTime(e.Date) : DateTime.Now).ToList();
            DateTime latest = entries.OrderByDescending(e => !string.IsNullOrEmpty(e.Date) ? Convert.ToDateTime(e.Date) : DateTime.Now).Select(e => !string.IsNullOrEmpty(e.Date) ? Convert.ToDateTime(e.Date) : DateTime.Now).FirstOrDefault();
            var selectedDate = string.IsNullOrEmpty(date) || date != "null" ? latest : DateTime.Parse(date);
            //var selectedEntry = entries.FirstOrDefault(e => (!string.IsNullOrEmpty(e.Date) ? Convert.ToDateTime(e.Date) : DateTime.Now) == selectedDate.Date);


            ViewBag.SelectedDate = selectedDate;
            ViewBag.Entries = _entryService.GetEntryListDateByNoteId(id);
            //ViewBag.Entry = selectedEntry;
            ViewBag.NoteTitle = note.Title;

            return View(note);
        }


        [HttpGet]
        public IActionResult GetDetailNote(string? id, string? date, string? noteId)
        {
            try
            {
                DailyEntry entry = new();
                if (!string.IsNullOrEmpty(id))
                {
                    entry = _entryService.GetEntryById(int.Parse(id));
                }
                else
                {
                    if (!string.IsNullOrEmpty(noteId))
                    {

                        entry = _entryService.GetEntriesByNoteId(int.Parse(noteId)).FirstOrDefault();

                    }
                }
                return Json(new { success = true, message = "success get detail", data = entry });
            }
            catch (Exception e)
            {
                return Json(new { success = false, message = "failed get detail" });
            }
        }

        [HttpPost]
        [ValidateAntiForgeryToken]
        public IActionResult AddEntry(DailyEntry entry)
        {
            entry.Created_by = UserId;
            entry.UserId = UserId ?? "guest";
            _entryService.AddEntry(entry);
            return Ok();
        }

        [HttpPost]
        public IActionResult UpdateEntry(DailyEntry entry)
        {
            entry.Modified_by = UserId;
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
            _entryService.UpdateDate(id, date, UserId);
            return Ok();
        }

        [HttpPost]
        public IActionResult DeleteEntry(int id)
        {
            _entryService.DeleteEntry(id, UserId);
            return Ok();
        }

        [HttpPost]
        public IActionResult ShareNote(ShareEmailModel model)
        {
            try
            {
                _emailHelper.SendEmail(model);
                return Json(new { success=true, message="Catatan berhasil dikirim" });
            }
            catch (Exception e)
            {
                return Json(new { success = false, message = "Catatan Gagal dikirim: "+e.Message });
            }
        }
    }
}
