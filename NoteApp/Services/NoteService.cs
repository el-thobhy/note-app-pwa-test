using Microsoft.Data.SqlClient;
using NoteApp.Models;
using NoteApp.Repository;

namespace NoteApp.Services
{
    public class NoteService : INoteService
    {
        private readonly string _connectionString;

        public NoteService(IConfiguration configuration)
        {
            _connectionString = configuration.GetConnectionString("DbConn");
        }

        public void CreateNote(Note note)
        {
            using var connection = new SqlConnection(_connectionString);
            connection.Open();
            using var transaction = connection.BeginTransaction();

            try
            {
                var repo = new NoteRepository(connection, transaction);
                repo.Insert(note);

                transaction.Commit();
            }
            catch (Exception ex)
            {
                transaction.Rollback();
                throw new Exception(ex.Message);
            }
        }

        public List<Note> GetAllNotes()
        {
            using var connection = new SqlConnection(_connectionString);
            connection.Open();
            using var transaction = connection.BeginTransaction();

            var repo = new NoteRepository(connection, transaction);
            return repo.GetAll();
        }
        
        public List<Note> GetAllNotesByUserId(string userId)
        {
            using var connection = new SqlConnection(_connectionString);
            connection.Open();
            using var transaction = connection.BeginTransaction();

            var repo = new NoteRepository(connection, transaction);
            return repo.GetAllByUserId(userId);
        }
        public List<DailyEntry> GetAllDailyEntriesByNoteId(string noteId)
        {
            using var connection = new SqlConnection(_connectionString);
            connection.Open();
            using var transaction = connection.BeginTransaction();

            var repo = new NoteRepository(connection, transaction);
            return repo.GetEntriesByNoteId(noteId) ?? [];
        }

        public Note? GetNoteById(int id)
        {
            using var connection = new SqlConnection(_connectionString);
            connection.Open();
            using var transaction = connection.BeginTransaction();

            var repo = new NoteRepository(connection, transaction);
            Note? note = repo.GetById(id);
            note.Entries = repo.GetEntriesByNoteId(id.ToString()) ?? [];
            return note;
        }

        public void UpdateNote(Note note)
        {
            using var connection = new SqlConnection(_connectionString);
            connection.Open();
            using var transaction = connection.BeginTransaction();

            try
            {
                var repo = new NoteRepository(connection, transaction);
                repo.Update(note);

                transaction.Commit();
            }
            catch (Exception ex)
            {
                transaction.Rollback();
                throw new Exception(ex.Message);
            }
        }

        public void DeleteNote(int id, string? deletedBy)
        {
            using var connection = new SqlConnection(_connectionString);
            connection.Open();
            using var transaction = connection.BeginTransaction();

            try
            {
                var repo = new NoteRepository(connection, transaction);
                repo.Delete(id, deletedBy);

                transaction.Commit();
            }
            catch (Exception ex) 
            {
                transaction.Rollback();
                throw new Exception(ex.Message);
            }
        }
    }

}
