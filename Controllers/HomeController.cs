using ELAuth.Helper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Newtonsoft.Json.Linq;
using NoteApp.Models;
using NoteApp.Services;
using NoteAppPWA.Controllers;
using static Azure.Core.HttpHeader;

namespace NoteApp.Controllers
{
    [Authorize(Roles = "home,account,role,authorization")]
    public class HomeController : BaseController
    {
        private readonly INoteService _noteService;
        private readonly IDailyEntryService _noteEntriesService;

        public HomeController(INoteService noteService, IDailyEntryService noteEntriesService)
        {
            _noteService = noteService;
            _noteEntriesService = noteEntriesService;
        }
        // GET: /Home/Index
        public IActionResult Index()
        {
            return View();
        }

        [HttpGet]
        public IActionResult GetDataHome()
        {
            List<Note> notes = [];
            try
            {
                List<DailyEntry> entries = [];
                if (UserId == "admin")
                {
                    notes = _noteService.GetAllNotes();
                    for (int i = 0; i < notes.Count; i++)
                    {
                        notes[i].Entries = _noteService.GetAllDailyEntriesByNoteId(notes[i].Id);
                    }
                }
                else
                {
                    notes = _noteService.GetAllNotesByUserId(UserId);
                    for (int i = 0; i < notes.Count; i++)
                    {
                        notes[i].Entries = _noteService.GetAllDailyEntriesByNoteId(notes[i].Id);
                    }
                }
                return Json(new { success=true, message="Get Data Success", data=notes } );
            }
            catch (Exception e)
            {
                return Json(new { success = false, message = "Get Data Failed: "+e.Message, data = notes });
            }
            
        }

        public JsonResult GetAllEntries()
        {
            try
            {
                List<DailyEntry> entries = _noteEntriesService.GetEntriesAll(UserId);
                return Json(new { data = entries });
            }
            catch (Exception)
            {
                return Json(new { data = new List<DailyEntry>() });
            }
        }

        // POST: /Home/Create
        [HttpPost]
        [ValidateAntiForgeryToken]
        public IActionResult Create(Note note)
        {
            note.Created_by = UserId;
            note.UserId = UserId;
            _noteService.CreateNote(note);
            return RedirectToAction(nameof(Index));
        }

        // GET: /Home/Edit/5
        [HttpGet]
        public IActionResult Edit(int id)
        {
            var note = _noteService.GetNoteById(id);
            if (note == null) return NotFound();
            return PartialView(note);
        }

        // POST: /Home/Edit/5
        [HttpPost]
        [ValidateAntiForgeryToken]
        public IActionResult Edit(Note note)
        {
            if (ModelState.IsValid)
            {
                string? userId = UserId;
                note.Modified_by = userId; // Ganti sesuai user
                _noteService.UpdateNote(note);
                return RedirectToAction(nameof(Index));
            }
            return View(note);
        }

        // GET: /Home/Delete/5
        public IActionResult Delete(int id)
        {
            var note = _noteService.GetNoteById(id);
            if (note == null) return NotFound();
            return View(note);
        }

        // POST: /Home/Delete/5
        [HttpPost]
        public IActionResult DeleteConfirmed(int id)
        {
            string? userId = JwtHelper.GetName(Token);
            _noteService.DeleteNote(id, userId); // Ganti dengan user login
            return RedirectToAction(nameof(Index));
        }
    }
}
